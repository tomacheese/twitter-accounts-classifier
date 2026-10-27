#!/usr/bin/env bash
set -euo pipefail

# このスクリプトは DATABASE_URL が指すテスト用 DB に対して破壊的に動作する。
# CI・ローカルとも、本番 DB には向けないこと。
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL is not set" >&2
  exit 1
fi
# libpq は ?host= クエリパラメータで authority 部分の host を上書きできるため、
# 先にこれを弾いておかないと authority だけを見るチェックをすり抜けられる。
if printf '%s' "$DATABASE_URL" | grep -qiE '[?&]host='; then
  echo "ERROR: DATABASE_URL contains a host= query parameter, which can override the actual connection target; refusing to run migrate reset" >&2
  exit 1
fi
# 部分一致だと evil-localhost.example.com のような decoy host も通ってしまうため、
# host 部分だけを取り出して比較する。パターンが一致しない場合は sed -n/p により
# 何も出力しない (元の DATABASE_URL をそのまま漏らさない) ので、次の空文字チェックで
# 弾かれる。
DB_HOST=$(printf '%s' "$DATABASE_URL" | sed -nE 's#^[a-zA-Z][a-zA-Z0-9+.-]*://([^:@/?]+(:[^@]*)?@)?([^:/?]+).*#\3#p')
if [ -z "$DB_HOST" ]; then
  echo "ERROR: could not parse a host from DATABASE_URL; refusing to run migrate reset" >&2
  exit 1
fi
case "$DB_HOST" in
  localhost|127.0.0.1) ;;
  *)
    echo "ERROR: DATABASE_URL host '$DB_HOST' does not look like a local test database; refusing to run migrate reset" >&2
    exit 1
    ;;
esac

cd "$(dirname "$0")/.."

MIGRATION_DIR="migrations"
NEW_MIGRATION_NAME=$(ls "$MIGRATION_DIR" | grep -E "retire_topic_rules")
STASH_DIR=$(mktemp -d)

cleanup() {
  if [ -d "$STASH_DIR/$NEW_MIGRATION_NAME" ] && [ ! -d "$MIGRATION_DIR/$NEW_MIGRATION_NAME" ]; then
    mv "$STASH_DIR/$NEW_MIGRATION_NAME" "$MIGRATION_DIR/$NEW_MIGRATION_NAME"
  fi
  rm -rf "$STASH_DIR"
}
trap cleanup EXIT INT TERM

# 非 topic ラベル (spam) に属する行の件数・集計値を 1 つの文字列にする。
# migration 前後で変化しないことを検証するために使う。
spam_snapshot() {
  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
    SELECT concat_ws(';',
      'latest=' || (SELECT COUNT(*) FROM \"AccountLabelLatest\" WHERE \"labelDefinitionId\" = 'l_spam'),
      'classification=' || (SELECT COUNT(*) FROM \"AccountClassificationLatest\" WHERE \"labelDefinitionId\" = 'l_spam'),
      'change=' || (SELECT COUNT(*) FROM \"AccountLabelChange\" WHERE \"labelDefinitionId\" = 'l_spam'),
      'run=' || (SELECT COUNT(*) FROM \"CrawlAccountLabelRun\" WHERE \"labelDefinitionId\" = 'l_spam'),
      'snapshot=' || (SELECT COUNT(*) FROM \"LabelMetricSnapshot\" WHERE \"labelDefinitionId\" = 'l_spam'),
      'daily=' || (SELECT COUNT(*) FROM \"LabelMetricDaily\" WHERE \"labelDefinitionId\" = 'l_spam'),
      'summary=' || (SELECT COUNT(*) FROM \"LabelSummaryCurrent\" WHERE \"labelDefinitionId\" = 'l_spam'),
      'value=' || COALESCE((SELECT SUM(\"count\") FROM \"AccountClassificationValueCount\" WHERE \"labelDefinitionId\" = 'l_spam'), 0),
      'confidence=' || COALESCE((SELECT SUM(\"count\") FROM \"AccountClassificationConfidenceBucketCount\" WHERE \"labelDefinitionId\" = 'l_spam'), 0),
      'ruleVersion=' || COALESCE((SELECT SUM(\"count\") FROM \"AccountClassificationRuleVersionCount\" WHERE \"labelDefinitionId\" = 'l_spam'), 0),
      'reason=' || COALESCE((SELECT SUM(\"count\") FROM \"AccountClassificationReasonCount\" WHERE \"labelDefinitionId\" = 'l_spam'), 0),
      'freshness=' || COALESCE((SELECT SUM(\"count\") FROM \"AccountClassificationFreshnessBucket\" WHERE \"labelDefinitionId\" = 'l_spam'), 0),
      'weekly=' || COALESCE((SELECT SUM(\"count\") FROM \"WeeklyReviewSampleBucketCount\" WHERE \"labelDefinitionId\" = 'l_spam'), 0),
      'definition=' || (SELECT COUNT(*) FROM \"LabelDefinition\" WHERE id = 'l_spam')
    )"
}

# migration 適用後 (および再適用後) に満たすべき状態を検証する。
assert_retired_state() {
  local topic_rows
  topic_rows=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
    SELECT
      (SELECT COUNT(*) FROM \"LabelDefinition\" WHERE key LIKE 'topic\\_%')
      + (SELECT COUNT(*) FROM \"AccountLabelLatest\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"AccountClassificationLatest\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"AccountLabelChange\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"CrawlAccountLabelRun\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"LabelMetricSnapshot\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"LabelMetricDaily\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"LabelSummaryCurrent\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"WeeklyReviewSampleBucketCount\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"AccountClassificationValueCount\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"AccountClassificationConfidenceBucketCount\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"AccountClassificationRuleVersionCount\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"AccountClassificationFreshnessBucket\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))
      + (SELECT COUNT(*) FROM \"AccountClassificationReasonCount\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food'))")
  if [ "$topic_rows" != "0" ]; then
    echo "FAIL: $topic_rows topic_* rows remain after the migration" >&2
    exit 1
  fi

  local spam_after
  spam_after=$(spam_snapshot)
  if [ "$spam_after" != "$SPAM_BEFORE" ]; then
    echo "FAIL: non-topic rows changed. before=[$SPAM_BEFORE] after=[$spam_after]" >&2
    exit 1
  fi

  local summaries
  summaries=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
    SELECT string_agg(\"accountId\" || ':' || \"activeLabelKeys\"::text || ':' || \"activeLabelCount\", ';' ORDER BY \"accountId\")
    FROM \"AccountSummaryLatest\"")
  if [ "$summaries" != "s1:{spam}:1;s2:{}:0;s3:{spam}:1" ]; then
    echo "FAIL: unexpected AccountSummaryLatest state: $summaries" >&2
    exit 1
  fi

  local counter_mismatch
  counter_mismatch=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
    SELECT \"labeledAccounts\" || ' vs ' || (SELECT COUNT(*) FROM \"AccountSummaryLatest\" WHERE \"activeLabelCount\" > 0)
    FROM \"LabeledAccountCounter\" WHERE id = 'global'")
  if [ "$counter_mismatch" != "2 vs 2" ]; then
    echo "FAIL: LabeledAccountCounter does not match activeLabelCount > 0 rows: $counter_mismatch" >&2
    exit 1
  fi

  local follow_state
  follow_state=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
    SELECT (SELECT COUNT(*) FROM \"Follow\") || ',' || COALESCE(to_regclass('\"LabelingFollowSample\"')::text, 'dropped')")
  if [ "$follow_state" != "1,dropped" ]; then
    echo "FAIL: expected Follow rows kept and LabelingFollowSample dropped, got: $follow_state" >&2
    exit 1
  fi
}

# 1. 新 migration を一時退避し、旧 schema 相当まで適用する。
mv "$MIGRATION_DIR/$NEW_MIGRATION_NAME" "$STASH_DIR/"
pnpm --filter analyzer exec prisma migrate reset --schema=../prisma/schema.prisma --force --skip-seed --skip-generate

# 2. 旧 schema 上に topic ラベルと非 topic ラベル (spam) の既存行を作る。
#    集計テーブルは AccountClassificationLatest/AccountLabelLatest のトリガーが埋める。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" <<'SQL'
INSERT INTO "LabelDefinition" (id, key, description) VALUES
  ('l_topic_tech', 'topic_tech', 'テスト用 topic_tech'),
  ('l_topic_food', 'topic_food', 'テスト用 topic_food'),
  ('l_spam', 'spam', 'テスト用 spam');

INSERT INTO "Account" (id, "screenName", "displayName", "followersCount", "followingCount", "tweetCount", "accountCreatedAt", "updatedAt") VALUES
  ('a1', 'alice', 'Alice', 1, 1, 1, now(), now()),
  ('a2', 'bob', 'Bob', 1, 1, 1, now(), now()),
  ('a3', 'carol', 'Carol', 1, 1, 1, now(), now());

INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", value, "labeledAt", confidence, reason, method, "ruleVersion") VALUES
  ('a1', 'l_topic_tech', true, now(), 0.9, 'reason_x', 'rule', '1.0.0'),
  ('a2', 'l_topic_food', false, now(), 0.2, 'reason_y', 'rule', '1.0.0'),
  ('a1', 'l_spam', true, now(), 0.8, 'reason_z', 'rule', '1.0.0'),
  ('a2', 'l_spam', false, now(), 0.1, 'reason_w', 'rule', '1.0.0');

INSERT INTO "AccountClassificationLatest" ("accountId", "labelDefinitionId", value, confidence, reason, method, "ruleVersion", "observedAt") VALUES
  ('a1', 'l_topic_tech', true, 0.9, 'reason_x', 'rule', '1.0.0', now() - interval '1 day'),
  ('a2', 'l_topic_food', false, 0.2, 'reason_y', 'rule', '1.0.0', now() - interval '10 days'),
  ('a1', 'l_spam', true, 0.8, 'reason_z', 'rule', '1.0.0', now() - interval '2 days'),
  ('a2', 'l_spam', false, 0.1, 'reason_w', 'rule', '1.0.0', now() - interval '3 days');

INSERT INTO "AccountLabelChange" (id, "accountId", "labelDefinitionId", "changeType") VALUES
  ('c1', 'a1', 'l_topic_tech', 'set'),
  ('c2', 'a1', 'l_spam', 'set');

INSERT INTO "CrawlRun" (id, "startedAt", status, "lastHeartbeatAt") VALUES ('run1', now(), 'success', now());
INSERT INTO "CrawlAccountLabelRun" (id, "crawlRunId", username, "accountId", "labelDefinitionId", method, "ruleVersion") VALUES
  ('r1', 'run1', 'alice', 'a1', 'l_topic_tech', 'rule', '1.0.0'),
  ('r2', 'run1', 'alice', 'a1', 'l_spam', 'rule', '1.0.0');

INSERT INTO "LabelMetricSnapshot" (id, "labelDefinitionId", "observedAt", "sourceWatermarkAt", "evaluatedCount", "trueCount", prevalence, completeness, "policyHash", "analyzerVersion", "triggerWorkItemId") VALUES
  ('m1', 'l_topic_tech', now(), now(), 2, 1, 0.5, 'complete', 'h', 'v', 'w1'),
  ('m2', 'l_spam', now(), now(), 2, 1, 0.5, 'complete', 'h', 'v', 'w2');
INSERT INTO "LabelMetricDaily" (id, date, "labelDefinitionId", "evaluatedCount", "trueCount", prevalence, "sourceObservedAt") VALUES
  ('d1', current_date, 'l_topic_tech', 2, 1, 0.5, now()),
  ('d2', current_date, 'l_spam', 2, 1, 0.5, now());
INSERT INTO "LabelSummaryCurrent" ("generationId", "labelDefinitionId", "evaluatedCount", "trueCount", prevalence, "qualityStatus", "sourceWatermarkAt", "updatedAt") VALUES
  ('gen1', 'l_topic_tech', 2, 1, 0.5, 'ok', now(), now()),
  ('gen1', 'l_spam', 2, 1, 0.5, 'ok', now(), now());

-- activeLabelCount が 0 に落ちる行 (s2) と、topic と非 topic が混在する行 (s1) を用意する。
INSERT INTO "AccountSummaryLatest" ("accountId", "normalizedScreenName", "normalizedDisplayName", "searchDocument", "profileObservedAt", "activeLabelKeys", "activeLabelCount", "updatedAt") VALUES
  ('s1', 'alice', 'alice', 'alice', now(), ARRAY['topic_tech', 'spam'], 2, now()),
  ('s2', 'bob', 'bob', 'bob', now(), ARRAY['topic_food'], 1, now()),
  ('s3', 'carol', 'carol', 'carol', now(), ARRAY['spam'], 1, now());

INSERT INTO "Follow" (id, "followerId", "followeeId") VALUES ('f1', 'a1', 'a2');
INSERT INTO "LabelingFollowSample" (id, "accountId", "followeeId") VALUES ('fs1', 'a1', 'a2');
SQL

# 集計テーブルが実際にトリガーで埋まっていなければ、以降の検証が空振りになるため先に確認する。
SEEDED_AGGREGATES=$(psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -tAc "
  SELECT COUNT(*) FROM \"AccountClassificationValueCount\" WHERE \"labelDefinitionId\" IN ('l_topic_tech', 'l_topic_food', 'l_spam')")
if [ "$SEEDED_AGGREGATES" = "0" ]; then
  echo "FAIL: aggregate tables were not populated by triggers; the fixture does not exercise the migration" >&2
  exit 1
fi
SPAM_BEFORE=$(spam_snapshot)

# 3. 新 migration を復元して適用し、続けて batch 削除スクリプトを実行する。
#    batch size を 1 にして、複数 batch に跨っても結果が変わらないことを確認する。
mv "$STASH_DIR/$NEW_MIGRATION_NAME" "$MIGRATION_DIR/"
pnpm --filter analyzer exec prisma migrate deploy --schema=../prisma/schema.prisma
RETIRE_TOPIC_PURGE_BATCH_SIZE=1 RETIRE_TOPIC_PURGE_SLEEP_MS=1 \
  pnpm --filter crawler exec tsx scripts/retire-topic-rules-purge.ts
assert_retired_state

# 4. 冪等性: migration と purge スクリプトをもう一度実行しても no-op で、状態が変わらない。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$MIGRATION_DIR/$NEW_MIGRATION_NAME/migration.sql"
RETIRE_TOPIC_PURGE_BATCH_SIZE=1 RETIRE_TOPIC_PURGE_SLEEP_MS=1 \
  pnpm --filter crawler exec tsx scripts/retire-topic-rules-purge.ts
assert_retired_state

echo "OK: topic_* rows were removed from every label table, non-topic rows were untouched, and reapplying is a no-op"
