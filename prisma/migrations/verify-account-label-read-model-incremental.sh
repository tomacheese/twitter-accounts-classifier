#!/usr/bin/env bash
set -euo pipefail

# このスクリプトは DATABASE_URL が指すテスト用 DB に対して破壊的に動作する。
# CI・ローカルとも、本番 DB には向けないこと。
cd "$(dirname "$0")/.."

MIGRATION_DIR="migrations"
NEW_MIGRATION_NAME=$(ls "$MIGRATION_DIR" | grep account_label_read_model_incremental)
STASH_DIR=$(mktemp -d)

cleanup() {
  if [ -d "$STASH_DIR/$NEW_MIGRATION_NAME" ] && [ ! -d "$MIGRATION_DIR/$NEW_MIGRATION_NAME" ]; then
    mv "$STASH_DIR/$NEW_MIGRATION_NAME" "$MIGRATION_DIR/$NEW_MIGRATION_NAME"
  fi
  rm -rf "$STASH_DIR"
}
trap cleanup EXIT

# 1. 新 migration を一時退避し、旧 schema 相当まで適用する。
mv "$MIGRATION_DIR/$NEW_MIGRATION_NAME" "$STASH_DIR/"
pnpm --filter crawler exec prisma migrate reset --schema=../prisma/schema.prisma --force --skip-seed --skip-generate

# 2. 旧 schema 上に、本番相当の既存行 (sourceCrawlRunId 必須・triggerWorkItemId 無し・
#    旧一意制約) を作る。
psql "$DATABASE_URL" <<'SQL'
INSERT INTO "LabelDefinition" (id, key, description)
  VALUES ('legacy_label', 'legacy_label', 'テスト用ラベル')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO "CrawlRun" (id, "startedAt", "lastHeartbeatAt", status)
  VALUES ('legacy_run', now(), now(), 'success')
  ON CONFLICT (id) DO NOTHING;
INSERT INTO "LabelMetricSnapshot"
  (id, "sourceCrawlRunId", "labelDefinitionId", "observedAt", "sourceWatermarkAt",
   "evaluatedCount", "trueCount", "prevalence", "completeness", "policyHash", "analyzerVersion")
VALUES
  ('legacy_snapshot', 'legacy_run', 'legacy_label', now(), now(), 10, 1, 0.1, 'complete', 'hash', 'legacy');
SQL

# 3. 新 migration を復元して適用する。ここで失敗すれば「既存行がある本番 DB に
#    安全に適用できない」ことを検出したことになる。
mv "$STASH_DIR/$NEW_MIGRATION_NAME" "$MIGRATION_DIR/"
pnpm --filter crawler exec prisma migrate deploy --schema=../prisma/schema.prisma

# 4. 既存行が壊れず、triggerWorkItemId が一意に backfill され、
#    旧一意制約が新一意制約へ正しく差し替わったことを検証する。
BACKFILLED=$(psql "$DATABASE_URL" -tAc \
  "SELECT \"triggerWorkItemId\" FROM \"LabelMetricSnapshot\" WHERE id = 'legacy_snapshot'")
if [[ "$BACKFILLED" != legacy:* ]]; then
  echo "FAIL: triggerWorkItemId was not backfilled correctly (got: $BACKFILLED)" >&2
  exit 1
fi

OLD_INDEX_EXISTS=$(psql "$DATABASE_URL" -tAc \
  "SELECT 1 FROM pg_indexes WHERE indexname = 'LabelMetricSnapshot_sourceCrawlRunId_labelDefinitionId_key'")
if [ -n "$OLD_INDEX_EXISTS" ]; then
  echo "FAIL: old unique index was not dropped" >&2
  exit 1
fi

NEW_INDEX_EXISTS=$(psql "$DATABASE_URL" -tAc \
  "SELECT 1 FROM pg_indexes WHERE indexname = 'LabelMetricSnapshot_triggerWorkItemId_labelDefinitionId_key'")
if [ -z "$NEW_INDEX_EXISTS" ]; then
  echo "FAIL: new unique index was not created" >&2
  exit 1
fi

echo "OK: migration applied safely against pre-existing LabelMetricSnapshot rows"
