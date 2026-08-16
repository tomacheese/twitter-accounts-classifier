#!/usr/bin/env bash
set -euo pipefail

# このスクリプトは DATABASE_URL が指すテスト用 DB に対して破壊的に動作する。
# CI・ローカルとも、本番 DB には向けないこと。
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set" >&2
  exit 1
fi
# 部分一致だと evil-localhost.example.com のような decoy host も通ってしまうため、
# host 部分だけを取り出して比較する。
DB_HOST=$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-zA-Z]+://([^:@/]+(:[^@]*)?@)?([^:/?]+).*#\3#')
case "$DB_HOST" in
  localhost|127.0.0.1) ;;
  *)
    echo "ERROR: DATABASE_URL host '$DB_HOST' does not look like a local test database; refusing to run migrate reset" >&2
    exit 1
    ;;
esac

cd "$(dirname "$0")/.."

MIGRATION_DIR="migrations"
NEW_MIGRATION_NAMES=$(ls "$MIGRATION_DIR" | grep -E "add_account_classification_reason_count|drop_reason_distribution_partial_index")
STASH_DIR=$(mktemp -d)

cleanup() {
  for name in $NEW_MIGRATION_NAMES; do
    if [ -d "$STASH_DIR/$name" ] && [ ! -d "$MIGRATION_DIR/$name" ]; then
      mv "$STASH_DIR/$name" "$MIGRATION_DIR/$name"
    fi
  done
  rm -rf "$STASH_DIR"
}
trap cleanup EXIT

# 1. 新 migration 群を一時退避し、旧 schema 相当まで適用する。
for name in $NEW_MIGRATION_NAMES; do
  mv "$MIGRATION_DIR/$name" "$STASH_DIR/"
done
pnpm --filter analyzer exec prisma migrate reset --schema=../prisma/schema.prisma --force --skip-seed --skip-generate

# 2. 旧 schema 上に既存行を作る (value=true/false・reason 重複ありのケースを混ぜる)。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
INSERT INTO "LabelDefinition" (id, key, description)
  VALUES ('reason_backfill_label_a', 'reason_backfill_label_a', 'テスト用ラベルA'),
         ('reason_backfill_label_b', 'reason_backfill_label_b', 'テスト用ラベルB')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO "AccountClassificationLatest"
  ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "observedAt")
VALUES
  ('reason_backfill_account_a', 'reason_backfill_label_a', true, 0.9, 'reason_x', 'rule', '1.0.0', now() - interval '1 day'),
  ('reason_backfill_account_b', 'reason_backfill_label_a', true, 0.8, 'reason_x', 'rule', '1.0.0', now() - interval '2 day'),
  ('reason_backfill_account_c', 'reason_backfill_label_a', false, 0.2, 'reason_y', 'rule', '1.1.0', now() - interval '10 days'),
  ('reason_backfill_account_a', 'reason_backfill_label_b', true, 0.5, 'reason_z', 'rule', '1.0.0', now());
SQL

# 3. 新 migration 群を復元して適用する。ここで失敗すれば「既存行がある本番 DB に
#    安全に適用できない」ことを検出したことになる。
for name in $NEW_MIGRATION_NAMES; do
  mv "$STASH_DIR/$name" "$MIGRATION_DIR/"
done
pnpm --filter analyzer exec prisma migrate deploy --schema=../prisma/schema.prisma

# 4. backfill 後の AccountClassificationReasonCount が、AccountClassificationLatest
#    WHERE value=true から素朴に集計した値と一致することを検証する。
MISMATCH=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT count(*) FROM (
    SELECT \"labelDefinitionId\", \"reason\", COUNT(*) AS naive_count
    FROM \"AccountClassificationLatest\" WHERE \"value\" = true GROUP BY 1, 2
  ) naive
  FULL OUTER JOIN \"AccountClassificationReasonCount\" agg
    ON agg.\"labelDefinitionId\" = naive.\"labelDefinitionId\" AND agg.\"reason\" = naive.\"reason\"
  WHERE naive.naive_count IS DISTINCT FROM agg.count
")
if [ "$MISMATCH" -ne 0 ]; then
  echo "FAIL: AccountClassificationReasonCount does not match naive aggregate ($MISMATCH mismatched rows)" >&2
  exit 1
fi

# 5. value=false の reason が一切保持されていないことを検証する。
FALSE_LEAK=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT count(*) FROM \"AccountClassificationReasonCount\" agg
  WHERE EXISTS (
    SELECT 1 FROM \"AccountClassificationLatest\" src
    WHERE src.\"labelDefinitionId\" = agg.\"labelDefinitionId\"
      AND src.\"reason\" = agg.\"reason\"
      AND src.\"value\" = false
  )
  AND NOT EXISTS (
    SELECT 1 FROM \"AccountClassificationLatest\" src
    WHERE src.\"labelDefinitionId\" = agg.\"labelDefinitionId\"
      AND src.\"reason\" = agg.\"reason\"
      AND src.\"value\" = true
  )
")
if [ "$FALSE_LEAK" -ne 0 ]; then
  echo "FAIL: AccountClassificationReasonCount contains value=false-only reason rows ($FALSE_LEAK rows)" >&2
  exit 1
fi

echo "OK: reason count migration applied safely and backfilled aggregate matches the naive aggregate"
