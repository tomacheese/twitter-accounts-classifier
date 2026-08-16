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
NEW_MIGRATION_NAMES=$(ls "$MIGRATION_DIR" | grep -E "add_labeled_account_counter")
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

# 1. 新 migration を一時退避し、旧 schema 相当まで適用する。
for name in $NEW_MIGRATION_NAMES; do
  mv "$MIGRATION_DIR/$name" "$STASH_DIR/"
done
pnpm --filter analyzer exec prisma migrate reset --schema=../prisma/schema.prisma --force --skip-seed --skip-generate

# 2. トリガー作成前から存在していた AccountSummaryLatest 行を作る
#    (activeLabelCount が 0 の行と正の行を混在させ、backfill の WHERE 条件が正しく絞り込むか検証する)。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
INSERT INTO "AccountSummaryLatest"
  ("accountId", "normalizedScreenName", "normalizedDisplayName", "searchDocument",
   "profileObservedAt", "activeLabelKeys", "activeLabelCount", "updatedAt")
VALUES
  ('legacy_counter_a', 'legacy_counter_a', 'legacy counter a', 'legacy_counter_a legacy counter a',
   now() - interval '1 day', ARRAY['spam'], 1, now()),
  ('legacy_counter_b', 'legacy_counter_b', 'legacy counter b', 'legacy_counter_b legacy counter b',
   now() - interval '2 days', ARRAY[]::text[], 0, now()),
  ('legacy_counter_c', 'legacy_counter_c', 'legacy counter c', 'legacy_counter_c legacy counter c',
   now() - interval '3 days', ARRAY['spam', 'topic_tech'], 2, now());
SQL

# 3. 新 migration を復元して適用する。ここで失敗すれば「既存行がある本番 DB に
#    安全に適用できない」ことを検出したことになる。
for name in $NEW_MIGRATION_NAMES; do
  mv "$STASH_DIR/$name" "$MIGRATION_DIR/"
done
pnpm --filter analyzer exec prisma migrate deploy --schema=../prisma/schema.prisma

# 4. backfill 後の LabeledAccountCounter が AccountSummaryLatest から素朴に集計した値と
#    一致することを検証する。
MISMATCH=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT count(*) FROM (
    SELECT (SELECT \"labeledAccounts\" FROM \"LabeledAccountCounter\" WHERE id = 'global') AS actual,
           (SELECT COUNT(*) FROM \"AccountSummaryLatest\" WHERE \"activeLabelCount\" > 0) AS naive
  ) diff
  WHERE actual IS DISTINCT FROM naive
")
if [ "$MISMATCH" -ne 0 ]; then
  echo "FAIL: LabeledAccountCounter does not match naive AccountSummaryLatest aggregate" >&2
  exit 1
fi

echo "OK: migration applied safely and LabeledAccountCounter backfill matches the naive aggregate"
