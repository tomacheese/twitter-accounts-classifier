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

pnpm --filter analyzer exec prisma migrate reset --schema=../prisma/schema.prisma --force --skip-seed --skip-generate
pnpm --filter analyzer exec prisma migrate deploy --schema=../prisma/schema.prisma

psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
INSERT INTO "Account"
  ("id", "screenName", "displayName", "followersCount", "followingCount", "tweetCount",
   "accountCreatedAt")
VALUES
  ('trigger_verify_account', 'trigger_verify_account', 'trigger verify account', 0, 0, 0, now());
INSERT INTO "LabelDefinition" (id, key, description)
  VALUES ('trigger_verify_label', 'trigger_verify_label', 'トリガー検証用ラベル');
SQL

# 1. value=true の新規 INSERT → 'added' が 1 行増える。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
INSERT INTO "AccountLabelLatest"
  ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt", "sourceKind", "sourceId")
VALUES
  ('trigger_verify_account', 'trigger_verify_label', true, 0.9, 'r1', 'rule', '1.0.0', now(), 'crawl', 'trigger_verify_crawl_run');
SQL
COUNT_AFTER_INSERT_TRUE=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT count(*) FROM \"AccountLabelChange\"
  WHERE \"accountId\" = 'trigger_verify_account' AND \"labelDefinitionId\" = 'trigger_verify_label'
")
if [ "$COUNT_AFTER_INSERT_TRUE" -ne 1 ]; then
  echo "FAIL: expected 1 AccountLabelChange row after value=true INSERT, got $COUNT_AFTER_INSERT_TRUE" >&2
  exit 1
fi
SOURCE_ID=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT \"sourceId\" FROM \"AccountLabelChange\"
  WHERE \"accountId\" = 'trigger_verify_account' AND \"labelDefinitionId\" = 'trigger_verify_label'
")
if [ "$SOURCE_ID" != "trigger_verify_crawl_run" ]; then
  echo "FAIL: expected AccountLabelChange.sourceId to carry over AccountLabelLatest.sourceId ('trigger_verify_crawl_run'), got '$SOURCE_ID'" >&2
  exit 1
fi
CHANGE_TYPE=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT \"changeType\" FROM \"AccountLabelChange\"
  WHERE \"accountId\" = 'trigger_verify_account' AND \"labelDefinitionId\" = 'trigger_verify_label'
")
if [ "$CHANGE_TYPE" != "added" ]; then
  echo "FAIL: expected changeType 'added', got '$CHANGE_TYPE'" >&2
  exit 1
fi

# 2. confidence のみ変更する UPDATE → 行数が変化しない。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
UPDATE "AccountLabelLatest" SET "confidence" = 0.5, "labeledAt" = now()
WHERE "accountId" = 'trigger_verify_account' AND "labelDefinitionId" = 'trigger_verify_label';
SQL
COUNT_AFTER_CONFIDENCE_UPDATE=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT count(*) FROM \"AccountLabelChange\"
  WHERE \"accountId\" = 'trigger_verify_account' AND \"labelDefinitionId\" = 'trigger_verify_label'
")
if [ "$COUNT_AFTER_CONFIDENCE_UPDATE" -ne 1 ]; then
  echo "FAIL: expected AccountLabelChange row count unchanged (1) after confidence-only UPDATE, got $COUNT_AFTER_CONFIDENCE_UPDATE" >&2
  exit 1
fi

# 3. value=false への UPDATE → 'removed' が 1 行増える (計 2 行)。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
UPDATE "AccountLabelLatest" SET "value" = false, "labeledAt" = now()
WHERE "accountId" = 'trigger_verify_account' AND "labelDefinitionId" = 'trigger_verify_label';
SQL
COUNT_AFTER_VALUE_UPDATE=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT count(*) FROM \"AccountLabelChange\"
  WHERE \"accountId\" = 'trigger_verify_account' AND \"labelDefinitionId\" = 'trigger_verify_label'
")
if [ "$COUNT_AFTER_VALUE_UPDATE" -ne 2 ]; then
  echo "FAIL: expected 2 AccountLabelChange rows after value=false UPDATE, got $COUNT_AFTER_VALUE_UPDATE" >&2
  exit 1
fi

# 4. value=false の新規 INSERT (別ラベル) → 行数が変化しない。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
INSERT INTO "LabelDefinition" (id, key, description)
  VALUES ('trigger_verify_label_2', 'trigger_verify_label_2', 'トリガー検証用ラベル2');
INSERT INTO "AccountLabelLatest"
  ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt")
VALUES
  ('trigger_verify_account', 'trigger_verify_label_2', false, 0.1, 'r2', 'rule', '1.0.0', now());
SQL
COUNT_AFTER_INSERT_FALSE=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT count(*) FROM \"AccountLabelChange\" WHERE \"accountId\" = 'trigger_verify_account'
")
if [ "$COUNT_AFTER_INSERT_FALSE" -ne 2 ]; then
  echo "FAIL: expected AccountLabelChange row count unchanged (2) after value=false INSERT, got $COUNT_AFTER_INSERT_FALSE" >&2
  exit 1
fi

echo "OK: AccountLabelChange trigger generates audit rows only on actual value transitions"
