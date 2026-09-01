#!/usr/bin/env bash
set -euo pipefail

# add_weekly_review_sample_bucket_index は列追加 migration に依存するため、
# 旧schema再現時の退避対象 pattern はこの2つの migration を両方含んでいなければならない。
cd "$(dirname "$0")"

SCRIPT="verify-weekly-review-sample-bucket.sh"
PATTERN=$(grep -oE 'grep -E "[^"]+"' "$SCRIPT" | head -n1 | sed -E 's/^grep -E "(.*)"$/\1/')

if [ -z "$PATTERN" ]; then
  echo "FAIL: could not extract the migration selection pattern from $SCRIPT" >&2
  exit 1
fi

MATCHED=$(ls . | grep -E "$PATTERN" || true)

EXPECTED_COLUMN_MIGRATION="20260901010000_add_weekly_review_sample_bucket"
EXPECTED_INDEX_MIGRATION="20260901020000_add_weekly_review_sample_bucket_index"

for expected in "$EXPECTED_COLUMN_MIGRATION" "$EXPECTED_INDEX_MIGRATION"; do
  if ! grep -qxF "$expected" <<< "$MATCHED"; then
    echo "FAIL: $SCRIPT's migration selection pattern does not match $expected" >&2
    exit 1
  fi
done

echo "OK: verify-weekly-review-sample-bucket.sh selects both the column and index migrations"
