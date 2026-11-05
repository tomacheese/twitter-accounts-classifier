#!/bin/bash
# 旧スキーマ (prisma/migrations) と新スキーマ (baseline) に同じ操作を与え、次を比べる。
# - AccountClassificationLatest の集計表 (ValueCount など) とトリガーの結果が一致する
# - AccountLabelChange の行が一致する。旧は AccountLabelLatest、新は AccountActiveLabel の監査トリガーが書く。
#   false 側の確信度と理由は新で失われるため、比べない。
#   true から評価不能への遷移は、新だけが unevaluable として記録するため、比較から除く。
#
# 使い捨ての PostgreSQL 17 コンテナを自分で起動し、本番の DB には一切接続しない。
# 前提: docker、psql、リポジトリルートで `pnpm install` 済みであること。
# 使い方: prisma/baseline/verify-parity.sh
set -euo pipefail

cd "$(dirname "$0")"
BASELINE_DIR="$(pwd)"
ROOT="$(cd ../.. && pwd)"
PRISMA="$ROOT/node_modules/.bin/prisma"
IMAGE="${BASELINE_VERIFY_PG_IMAGE:-postgres:17-alpine}"
NAME="baseline-parity-pg-$$"
WORK="$(mktemp -d)"

cleanup() {
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=verify -p 127.0.0.1::5432 "$IMAGE" -c fsync=off >/dev/null
PORT="$(docker port "$NAME" 5432/tcp | head -n 1 | sed 's/.*://')"
ADMIN="postgresql://postgres:verify@127.0.0.1:$PORT"
ready=0
for _ in $(seq 1 60); do
    if psql -X -q "$ADMIN/postgres" -c 'SELECT 1' >/dev/null 2>&1; then
        ready=$((ready + 1))
        [ "$ready" -ge 3 ] && break
    else
        ready=0
    fi
    sleep 1
done
[ "$ready" -ge 3 ] || fail "scratch postgres did not become ready"

OLD="$ADMIN/parity_old"
NEW="$ADMIN/parity_new"
psql -X -q "$ADMIN/postgres" -c "CREATE DATABASE parity_old" -c "CREATE DATABASE parity_new"

# 旧: 現行の migration 群を適用する。新: baseline を単一トランザクションで適用する。
DATABASE_URL="$OLD" "$PRISMA" migrate deploy --schema "$ROOT/prisma/schema.prisma" >/dev/null
psql -X -q -v ON_ERROR_STOP=1 -1 "$NEW" \
    -f "$BASELINE_DIR/baseline.sql" -f "$BASELINE_DIR/tweet-hash.sql" -f "$BASELINE_DIR/functions.sql" >/dev/null
echo "old migrations and new baseline applied"

# 両 DB に渡す基準時刻。分単位のバケットが実行時刻のずれで食い違わないよう、時の頭に丸める。
ANCHOR="$(date -u -d '-3 hours' +%Y-%m-%dT%H:00:00Z)"

# --- AccountClassificationLatest の集計 ---
psql -X -q -v ON_ERROR_STOP=1 -v "anchor=$ANCHOR" "$OLD" -f "$BASELINE_DIR/parity-acl.sql"
psql -X -q -v ON_ERROR_STOP=1 -v "anchor=$ANCHOR" "$NEW" -f "$BASELINE_DIR/parity-acl.sql"
psql -X -v ON_ERROR_STOP=1 -f "$BASELINE_DIR/parity-acl-dump.sql" "$OLD" >"$WORK/acl_old.txt"
psql -X -v ON_ERROR_STOP=1 -f "$BASELINE_DIR/parity-acl-dump.sql" "$NEW" >"$WORK/acl_new.txt"
[ -s "$WORK/acl_old.txt" ] || fail "ACL aggregate dump is empty (the scenario did not exercise the triggers)"
diff "$WORK/acl_old.txt" "$WORK/acl_new.txt" >"$WORK/acl.diff" || fail "ACL aggregate tables differ:
$(cat "$WORK/acl.diff")"
echo "ACL aggregate tables: identical ($(wc -l <"$WORK/acl_old.txt") rows)"

# --- AccountLabelChange ---
# 同じ遷移列を与える。時刻は固定の 1 時間刻みで、ラベルは 1 (Account 6001〜6003)。
#   6001: なし -> true -> false -> true (added, removed, added)
#   6002: false (初回の false は記録しない) -> true (added) -> true (確信度のみ変更、記録しない)
#   6003: true -> 評価不能 (新だけ unevaluable を記録する)
psql -X -q -v ON_ERROR_STOP=1 -v "anchor=$ANCHOR" "$OLD" <<'SQL'
INSERT INTO "LabelDefinition" ("id", "key", "description") VALUES ('1', 'parity_label', '検証用');
INSERT INTO "Account" ("id", "screenName", "displayName", "followersCount", "followingCount", "tweetCount", "accountCreatedAt", "updatedAt")
SELECT i::text, 'parity_' || i, 'Parity ' || i, 0, 0, 0, now(), now() FROM generate_series(6001, 6003) AS i;
INSERT INTO "AccountLabelLatest"
  ("accountId", "labelDefinitionId", "value", "labeledAt", "confidence", "reason", "method", "ruleVersion", "sourceId")
VALUES
  ('6001', '1', true, :'anchor'::timestamptz + interval '1 hour', 0.9, 'r1', 'rule', 'v1', 'run1'),
  ('6002', '1', false, :'anchor'::timestamptz + interval '1 hour', 0.1, 'r0', 'rule', 'v1', 'run1'),
  ('6003', '1', true, :'anchor'::timestamptz + interval '1 hour', 0.8, 'r3', 'rule', 'v1', 'run1');
UPDATE "AccountLabelLatest" SET "value" = false, "labeledAt" = :'anchor'::timestamptz + interval '2 hours',
  "confidence" = 0.2, "reason" = 'r2', "sourceId" = 'run2' WHERE "accountId" = '6001';
UPDATE "AccountLabelLatest" SET "value" = true, "labeledAt" = :'anchor'::timestamptz + interval '3 hours',
  "confidence" = 0.95, "reason" = 'r4', "sourceId" = 'run3' WHERE "accountId" = '6001';
UPDATE "AccountLabelLatest" SET "value" = true, "labeledAt" = :'anchor'::timestamptz + interval '2 hours',
  "confidence" = 0.7, "reason" = 'r5', "sourceId" = 'run2' WHERE "accountId" = '6002';
UPDATE "AccountLabelLatest" SET "confidence" = 0.75, "labeledAt" = :'anchor'::timestamptz + interval '3 hours',
  "sourceId" = 'run3' WHERE "accountId" = '6002';
SQL

psql -X -q -v ON_ERROR_STOP=1 -v "anchor=$ANCHOR" "$NEW" <<'SQL'
INSERT INTO "LabelDefinition" (key, description) VALUES ('parity_label', '検証用');
CREATE FUNCTION pg_temp.put(p_account bigint, p_outcome smallint, p_confidence double precision,
  p_reason text, p_at timestamptz, p_source text) RETURNS void LANGUAGE sql AS $$
  SELECT set_label_result(
    ARRAY[p_account], ARRAY[1::smallint],
    ARRAY[coalesce((SELECT rev FROM "AccountLabelState" WHERE "accountId" = p_account), 0)],
    ARRAY[p_outcome], ARRAY[1::smallint], ARRAY[p_confidence], ARRAY[p_reason],
    ARRAY[CASE WHEN p_outcome = 1 THEN 'rule' END],
    p_at, 1::smallint, p_source, NULL)
$$;
SELECT pg_temp.put(6001, 1::smallint, 0.9, 'r1', :'anchor'::timestamptz + interval '1 hours', 'run1');
SELECT pg_temp.put(6002, 0::smallint, NULL, NULL, :'anchor'::timestamptz + interval '1 hours', 'run1');
SELECT pg_temp.put(6003, 1::smallint, 0.8, 'r3', :'anchor'::timestamptz + interval '1 hours', 'run1');
SELECT pg_temp.put(6001, 0::smallint, NULL, NULL, :'anchor'::timestamptz + interval '2 hours', 'run2');
SELECT pg_temp.put(6001, 1::smallint, 0.95, 'r4', :'anchor'::timestamptz + interval '3 hours', 'run3');
SELECT pg_temp.put(6002, 1::smallint, 0.7, 'r5', :'anchor'::timestamptz + interval '2 hours', 'run2');
SELECT pg_temp.put(6002, 1::smallint, 0.75, 'r5', :'anchor'::timestamptz + interval '3 hours', 'run3');
SELECT pg_temp.put(6003, -1::smallint, NULL, NULL, :'anchor'::timestamptz + interval '2 hours', 'run2');
SQL

psql -X -v ON_ERROR_STOP=1 -f "$BASELINE_DIR/parity-change-dump.sql" "$OLD" >"$WORK/change_old.txt"
psql -X -v ON_ERROR_STOP=1 -f "$BASELINE_DIR/parity-change-dump.sql" "$NEW" >"$WORK/change_new.txt"
[ -s "$WORK/change_old.txt" ] || fail "AccountLabelChange (old) is empty"

# 新だけが記録する unevaluable の行を取り除いてから比べる。
grep -v '|unevaluable|' "$WORK/change_new.txt" >"$WORK/change_new_comparable.txt" || true
diff "$WORK/change_old.txt" "$WORK/change_new_comparable.txt" >"$WORK/change.diff" || fail "AccountLabelChange rows differ:
$(cat "$WORK/change.diff")"
echo "AccountLabelChange: identical except the unevaluable transition ($(wc -l <"$WORK/change_old.txt") rows)"

UNEVAL="$(grep -c '^6003|1|unevaluable|true||' "$WORK/change_new.txt" || true)"
[ "$UNEVAL" = "1" ] || fail "expected exactly one unevaluable change for account 6003, got $UNEVAL"
echo "AccountLabelChange: true -> unevaluable is recorded once as unevaluable (new only)"
echo "parity verification passed"
