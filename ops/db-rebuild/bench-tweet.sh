#!/bin/bash
# Tweet のパーティション方式 (HASH(accountId) と RANGE(id)) を比べる計測。新 DB (scratch) に対してだけ実行する。
# 使い方: ops/db-rebuild/bench-tweet.sh <ラベル>    (結果は $WORK_DIR/bench.<ラベル>.txt にも残る)
#
# 計測項目:
#   - サイズ (表、インデックス、子パーティション数)
#   - アカウント指定の直近 20 件の取得 (コールド、ウォーム)
#   - ID 単独の取得 (親ツイートの取得に相当、コールド、ウォーム)
#   - reply corpus の取得 (コールド、ウォーム)
#   - pg_dump の所要時間 (直列と並列)
# コールドは、コンテナの再起動 (shared_buffers を空にする) と、ホストのページキャッシュの破棄 (特権コンテナ経由) で作る。
# ページキャッシュの破棄はホスト全体に影響する (一時的に他のプロセスが遅くなる)。DROP_CACHES=0 で省ける。
# 環境変数: BENCH_ACCOUNTS (既定 300)、BENCH_IDS (既定 300)、DUMP_JOBS (既定 4)、NEW_CONTAINER など (lib.sh)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

LABEL="${1:?usage: $0 <label>}"
OUT="$WORK_DIR/bench.$LABEL.txt"
: >"$OUT"
: "${BENCH_ACCOUNTS:=300}" "${BENCH_IDS:=300}" "${DUMP_JOBS:=4}" "${DROP_CACHES:=1}"

say() { printf '%s\n' "$*" | tee -a "$OUT" >&2; }

cold() {
    docker restart -t 120 "$NEW_CONTAINER" >/dev/null
    local i
    for i in $(seq 1 60); do
        new_psql -Atc 'SELECT 1' >/dev/null 2>&1 && break
        sleep 1
    done
    if [ "$DROP_CACHES" = 1 ]; then
        docker run --rm --privileged alpine sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'
    fi
}

timed() { # label sqlfile
    { printf '\\timing on\n'; cat "$2"; } | new_psql -q -At 2>&1 | python3 -I "$HERE/tools/lat-stats.py" "$1" | tee -a "$OUT" >&2
}

new_psql -q -c "VACUUM (ANALYZE) \"Tweet\"" >/dev/null
say "== bench $LABEL: $(new_q "SELECT CASE partstrat WHEN 'h' THEN 'HASH(accountId)' ELSE 'RANGE(id)' END FROM pg_partitioned_table WHERE partrelid = '\"Tweet\"'::regclass"), $(new_q "SELECT count(*) FROM pg_inherits WHERE inhparent = '\"Tweet\"'::regclass") partitions, $(new_q "SELECT count(*) FROM \"Tweet\"") rows"
say "size: table+indexes $(new_q "SELECT pg_size_pretty(sum(pg_total_relation_size(inhrelid))) FROM pg_inherits WHERE inhparent = '\"Tweet\"'::regclass") (heap $(new_q "SELECT pg_size_pretty(sum(pg_relation_size(inhrelid))) FROM pg_inherits WHERE inhparent = '\"Tweet\"'::regclass"), indexes $(new_q "SELECT pg_size_pretty(sum(pg_indexes_size(inhrelid))) FROM pg_inherits WHERE inhparent = '\"Tweet\"'::regclass"))"

# 標本 (固定の並びで選ぶ)
new_q "SELECT \"accountId\" FROM (SELECT DISTINCT \"accountId\" FROM \"Tweet\") a ORDER BY hashtext(\"accountId\"::text), \"accountId\" LIMIT $BENCH_ACCOUNTS" >"$WORK_DIR/bench.accounts"
new_q "SELECT \"id\" FROM \"Tweet\" ORDER BY hashtext(\"id\"::text), \"id\" LIMIT $BENCH_IDS" >"$WORK_DIR/bench.ids"
[ -s "$WORK_DIR/bench.accounts" ] && [ -s "$WORK_DIR/bench.ids" ] || die "empty benchmark sample"

q_recent="$WORK_DIR/bench.q.recent"
q_byid="$WORK_DIR/bench.q.byid"
q_reply="$WORK_DIR/bench.q.reply"
while read -r a; do
    printf 'SELECT count(*) FROM (SELECT "id", "createdAt", "fullText" FROM "Tweet" WHERE "accountId" = %s ORDER BY "createdAt" DESC LIMIT 20) s;\n' "$a"
done <"$WORK_DIR/bench.accounts" >"$q_recent"
while read -r i; do
    printf 'SELECT count(*) FROM (SELECT * FROM "Tweet" WHERE "id" = %s) s;\n' "$i"
done <"$WORK_DIR/bench.ids" >"$q_byid"
for _ in 1 2 3 4 5; do
    printf 'SELECT count(*) FROM (SELECT "id", "fullText" FROM "Tweet" WHERE "isReply" ORDER BY "collectedAt" DESC, "id" DESC LIMIT 5000) s;\n'
done >"$q_reply"

for kind in recent byid reply; do
    cold
    timed "$kind cold(first pass)" "$WORK_DIR/bench.q.$kind"
    timed "$kind warm(second pass)" "$WORK_DIR/bench.q.$kind"
done

# 実行計画 (参考)
acct="$(head -n1 "$WORK_DIR/bench.accounts")"
tid="$(head -n1 "$WORK_DIR/bench.ids")"
{
    echo "-- plan: recent 20 tweets of an account"
    new_psql -At -c "EXPLAIN (COSTS OFF) SELECT \"id\" FROM \"Tweet\" WHERE \"accountId\" = $acct ORDER BY \"createdAt\" DESC LIMIT 20" </dev/null | head -n 12
    echo "-- plan: lookup by id"
    new_psql -At -c "EXPLAIN (COSTS OFF) SELECT * FROM \"Tweet\" WHERE \"id\" = $tid" </dev/null | head -n 12
} | tee -a "$OUT" >&2

# dump (Tweet と子パーティションだけ)。直列は /dev/null へ (読み出しとシリアライズの時間)、並列は実ファイルへ。
cold
t0=$SECONDS
docker exec "$NEW_CONTAINER" pg_dump -U "$NEW_DB_USER" -d "$NEW_DB_NAME" -Fc -Z 0 --no-sync --table-and-children='"Tweet"' -f /dev/null
say "dump serial (custom, no compression, to /dev/null): $((SECONDS - t0))s"
cold
t0=$SECONDS
docker exec "$NEW_CONTAINER" sh -c "rm -rf /tmp/dump-bench && pg_dump -U $NEW_DB_USER -d $NEW_DB_NAME -Fd -j $DUMP_JOBS -Z 0 --no-sync --table-and-children='\"Tweet\"' -f /tmp/dump-bench"
say "dump parallel (directory, -j $DUMP_JOBS, no compression): $((SECONDS - t0))s, $(docker exec "$NEW_CONTAINER" du -sh /tmp/dump-bench | cut -f1)"
docker exec "$NEW_CONTAINER" rm -rf /tmp/dump-bench
say "== done"
