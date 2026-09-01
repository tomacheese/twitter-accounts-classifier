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
NEW_MIGRATION_NAMES=$(ls "$MIGRATION_DIR" | grep -E "add_weekly_review_sample_bucket$|add_weekly_review_sample_bucket_index$")
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

# 1. 新 migration を一時退避し、evaluable/labeledAt 列と
#    WeeklyReviewSampleBucketCount を持たない旧 schema まで適用する。
for name in $NEW_MIGRATION_NAMES; do
  mv "$MIGRATION_DIR/$name" "$STASH_DIR/"
done
pnpm --filter analyzer exec prisma migrate reset --schema=../prisma/schema.prisma --force --skip-seed --skip-generate

# 2. 新 migration を復元して適用する。
for name in $NEW_MIGRATION_NAMES; do
  mv "$STASH_DIR/$name" "$MIGRATION_DIR/"
done
pnpm --filter analyzer exec prisma migrate deploy --schema=../prisma/schema.prisma

# 3. INSERT / UPDATE (false→true, true→false, value flip) / DELETE それぞれの後の
#    WeeklyReviewSampleBucketCount を手動で assert する。
#    bucket は同一 accountId であれば呼び出しごとに固定なので、
#    実際の値を weekly_review_sample_bucket() から取得して期待値を組み立てる。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
INSERT INTO "LabelDefinition" (id, key, description)
  VALUES ('wrs_label', 'wrs_label', 'weekly review sampling テスト用ラベル')
  ON CONFLICT (id) DO NOTHING;
SQL

BUCKET_A=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "SELECT weekly_review_sample_bucket('wrs_account_a')")
BUCKET_B=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "SELECT weekly_review_sample_bucket('wrs_account_b')")

assert_count() {
  local label="$1" value="$2" bucket="$3" expected="$4"
  local actual
  actual=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc \
    "SELECT COALESCE((SELECT count FROM \"WeeklyReviewSampleBucketCount\" WHERE \"labelDefinitionId\"='$label' AND value=$value AND bucket=$bucket), 0)")
  if [ "$actual" != "$expected" ]; then
    echo "FAIL: $label/value=$value/bucket=$bucket expected count=$expected but got $actual" >&2
    exit 1
  fi
}

# 3-1. INSERT (evaluable=false, labeledAt=null): 対象外なので count は増えない。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "
INSERT INTO \"AccountClassificationLatest\"
  (\"accountId\", \"labelDefinitionId\", \"value\", \"confidence\", \"reason\", \"method\", \"ruleVersion\", \"observedAt\")
VALUES ('wrs_account_a', 'wrs_label', true, 0.9, 'r', 'rule', '1.0.0', now());
"
assert_count wrs_label true "$BUCKET_A" 0

# 3-2. UPDATE false→true (eligible になる): count が 1 増える。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "
UPDATE \"AccountClassificationLatest\" SET \"evaluable\" = true, \"labeledAt\" = now()
WHERE \"accountId\" = 'wrs_account_a' AND \"labelDefinitionId\" = 'wrs_label';
"
assert_count wrs_label true "$BUCKET_A" 1

# 3-3. semantic field だけの UPDATE (value/evaluable/labeledAt は不変): count は変化しない。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "
UPDATE \"AccountClassificationLatest\" SET \"confidence\" = 0.5, \"observedAt\" = now()
WHERE \"accountId\" = 'wrs_account_a' AND \"labelDefinitionId\" = 'wrs_label';
"
assert_count wrs_label true "$BUCKET_A" 1

# 3-4. value flip (true→false、eligible のまま): true 側が減り false 側が増える。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "
UPDATE \"AccountClassificationLatest\" SET \"value\" = false
WHERE \"accountId\" = 'wrs_account_a' AND \"labelDefinitionId\" = 'wrs_label';
"
assert_count wrs_label true "$BUCKET_A" 0
assert_count wrs_label false "$BUCKET_A" 1

# 3-5. UPDATE true→false 相当 (eligible→not eligible): count が減る。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "
UPDATE \"AccountClassificationLatest\" SET \"evaluable\" = false
WHERE \"accountId\" = 'wrs_account_a' AND \"labelDefinitionId\" = 'wrs_label';
"
assert_count wrs_label false "$BUCKET_A" 0

# 3-6. 別 account を eligible な状態で INSERT してから DELETE: count が増えて減る。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "
INSERT INTO \"AccountClassificationLatest\"
  (\"accountId\", \"labelDefinitionId\", \"value\", \"confidence\", \"reason\", \"method\", \"ruleVersion\",
   \"observedAt\", \"evaluable\", \"labeledAt\")
VALUES ('wrs_account_b', 'wrs_label', true, 0.9, 'r', 'rule', '1.0.0', now(), true, now());
"
assert_count wrs_label true "$BUCKET_B" 1
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "
DELETE FROM \"AccountClassificationLatest\" WHERE \"accountId\" = 'wrs_account_b' AND \"labelDefinitionId\" = 'wrs_label';
"
assert_count wrs_label true "$BUCKET_B" 0

# 3-7. bucket は 0..4095 の範囲に収まり、同一 accountId は常に同一 bucket を返す。
RANGE_VIOLATION=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
SELECT count(*) FROM (VALUES ('wrs_account_a'), ('wrs_account_b'), ('wrs_account_c')) AS t(account_id)
WHERE weekly_review_sample_bucket(account_id) NOT BETWEEN 0 AND 4095
")
if [ "$RANGE_VIOLATION" -ne 0 ]; then
  echo "FAIL: weekly_review_sample_bucket returned a value outside 0..4095" >&2
  exit 1
fi
REPEAT_MISMATCH=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
SELECT count(*) FROM generate_series(1, 3) AS i
WHERE weekly_review_sample_bucket('wrs_account_a') <> weekly_review_sample_bucket('wrs_account_a')
")
if [ "$REPEAT_MISMATCH" -ne 0 ]; then
  echo "FAIL: weekly_review_sample_bucket is not deterministic for the same accountId" >&2
  exit 1
fi

echo "OK: WeeklyReviewSampleBucketCount trigger transitions match expected counts"
