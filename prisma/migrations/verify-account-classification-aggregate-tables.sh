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
NEW_MIGRATION_NAMES=$(ls "$MIGRATION_DIR" | grep -E "add_account_classification_aggregate_tables|add_account_classification_latest_reason_cover_index")
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

# 2. 旧 schema 上に既存行を作る (label 2 件・account 2 件分、value/confidence/ruleVersion/
#    observedAt を分散させて集計が一致するかを検証できるようにする)。
#    AccountClassificationLatest は Account への外部キーを持たないため、
#    Account 行自体の作成は不要。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
INSERT INTO "LabelDefinition" (id, key, description)
  VALUES ('legacy_label_a', 'legacy_label_a', 'テスト用ラベルA'),
         ('legacy_label_b', 'legacy_label_b', 'テスト用ラベルB')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO "AccountClassificationLatest"
  ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "observedAt")
VALUES
  ('legacy_account_a', 'legacy_label_a', true, 0.9, 'r_a', 'rule', '1.0.0', now() - interval '1 day'),
  ('legacy_account_b', 'legacy_label_a', false, 0.2, 'r_b', 'rule', '1.1.0', now() - interval '10 days'),
  ('legacy_account_a', 'legacy_label_b', true, 0.5, 'r_c', 'rule', '1.0.0', now());
SQL

# 3. 新 migration 群を復元して適用する。ここで失敗すれば「既存行がある本番 DB に
#    安全に適用できない」ことを検出したことになる。
for name in $NEW_MIGRATION_NAMES; do
  mv "$STASH_DIR/$name" "$MIGRATION_DIR/"
done
pnpm --filter analyzer exec prisma migrate deploy --schema=../prisma/schema.prisma

# 4. backfill 後の 4 テーブルが AccountClassificationLatest から素朴に集計した値と
#    一致することを検証する。
MISMATCH=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT count(*) FROM (
    SELECT \"labelDefinitionId\", \"value\", COUNT(*) AS naive_count, SUM(\"confidence\") AS naive_sum
    FROM \"AccountClassificationLatest\" GROUP BY 1, 2
  ) naive
  FULL OUTER JOIN \"AccountClassificationValueCount\" agg
    ON agg.\"labelDefinitionId\" = naive.\"labelDefinitionId\" AND agg.\"value\" = naive.\"value\"
  WHERE naive.naive_count IS DISTINCT FROM agg.count
     OR naive.naive_sum IS DISTINCT FROM agg.\"confidenceSum\"
")
if [ "$MISMATCH" -ne 0 ]; then
  echo "FAIL: AccountClassificationValueCount does not match naive aggregate ($MISMATCH mismatched rows)" >&2
  exit 1
fi

FRESHNESS_MISMATCH=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT count(*) FROM (
    SELECT \"labelDefinitionId\",
      CASE WHEN (now() AT TIME ZONE 'UTC') - \"observedAt\" > interval '7 days' THEN TIMESTAMP '1970-01-01'
           ELSE date_trunc('minute', \"observedAt\") END AS bucket,
      COUNT(*) AS naive_count
    FROM \"AccountClassificationLatest\" GROUP BY 1, 2
  ) naive
  FULL OUTER JOIN \"AccountClassificationFreshnessBucket\" agg
    ON agg.\"labelDefinitionId\" = naive.\"labelDefinitionId\" AND agg.\"observedAtBucket\" = naive.bucket
  WHERE naive.naive_count IS DISTINCT FROM agg.count
")
if [ "$FRESHNESS_MISMATCH" -ne 0 ]; then
  echo "FAIL: AccountClassificationFreshnessBucket does not match naive aggregate ($FRESHNESS_MISMATCH mismatched rows)" >&2
  exit 1
fi

echo "OK: migration applied safely and backfilled aggregate tables match the naive aggregate"
