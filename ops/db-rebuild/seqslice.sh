#!/bin/bash
# 切り替え本番に近い経路 (表の物理順 = TID 範囲の逐次読み出し) を、小さなスライスで計測する。
# シャード実行 (rehearsal.sh) はアカウント単位の散在した読み出しになるため、全量の所要時間の見積もりには使えない。
# 旧 DB は読み取り専用で、1 本ずつ直列に読む。旧ホストの監視 (load average、IO 圧力) は lib.sh のものをそのまま使う。
#
# 計測項目 (Tweet と AccountLabelLatest のそれぞれ):
#   1. 旧 DB の素の逐次読み出し (count(*) だけ)
#   2. 変換 SELECT の出力を受け取る速度 (旧 DB から手元のファイルへ)
#   3. Tweet のみ: 振り分け (tweet-route.py) の速度
#   4. 新 DB への COPY ... FREEZE の速度
#   5. Tweet: インデックスの作成速度 / AccountLabelLatest: stg から状態の配列を組み立てる速度
#   6. Tweet のみ: id 範囲での取得 (旧 DB の PK を使う走査) の速度
# 前提: rehearsal.sh の prepare 済みの WORK_DIR (lmap.json など) と、投入済みの新 DB (表の定義を借りる)。
# 結果は $WORK_DIR/seqslice.txt に残る。作業用の表は新 DB の seq スキーマに作り、最後に落とす。
# 環境変数: SLICE_BLOCKS (既定 196608 = 1.5 GiB)、RAW_BLOCKS (既定 32768 = 0.25 GiB)、ID_ROWS (既定 200000)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

: "${SLICE_BLOCKS:=196608}" "${RAW_BLOCKS:=32768}" "${ID_ROWS:=200000}"
THROTTLE_SLEEP=0
OUT="$WORK_DIR/seqslice.txt"
SLICE_DIR="$WORK_DIR/slice"
: >"$OUT"
rm -rf "$SLICE_DIR"
mkdir -p "$SLICE_DIR"

say() { printf '%s\n' "$*" | tee -a "$OUT" >&2; }
now() { date +%s.%N; }
# stage <名前> <バイト数> <開始時刻> <終了時刻>
rate() { awk -v n="$1" -v b="$2" -v a="$3" -v z="$4" 'BEGIN { s = z - a; printf "%-46s %9.1f s  %8.1f MB/s (%.2f GiB)\n", n, s, b / 1e6 / s, b / 1073741824 }'; }

trap 'stop_guard; new_psql -q -c "DROP SCHEMA IF EXISTS seq CASCADE" >/dev/null 2>&1 || true' EXIT
unset SNAPSHOT_ID
start_guard

# scope は psql の \set に渡すため、文字列リテラルの引用符を二重にする (make_batches と同じ)。
tid_scope() { printf "t.ctid >= ''(%s,0)''::tid AND t.ctid < ''(%s,0)''::tid" "$1" "$(($1 + $2))" >"$3"; }

old_blocks() { printf 'SELECT pg_relation_size('"'"'"%s"'"'"') / 8192;\n' "$1" | old_psql -At; }

new_psql -q -c "DROP SCHEMA IF EXISTS seq CASCADE" -c "CREATE SCHEMA seq" >/dev/null

# ---- Tweet ----
tw_blocks="$(old_blocks Tweet)"
say "== Tweet: $tw_blocks blocks ($(awk -v b="$tw_blocks" 'BEGIN { printf "%.1f", b * 8192 / 1073741824 }') GiB heap)"
raw_start=$((tw_blocks / 4))
slice_start=$((tw_blocks * 3 / 4))
guard_ok
printf 'SELECT count(*) FROM "Tweet" t WHERE ctid >= '"'"'(%s,0)'"'"'::tid AND ctid < '"'"'(%s,0)'"'"'::tid;\n' "$raw_start" "$((raw_start + RAW_BLOCKS))" >"$SLICE_DIR/raw.sql"
t0=$(now)
{ old_prelude; cat "$SLICE_DIR/raw.sql"; echo 'COMMIT;'; } | old_psql -At >/dev/null
t1=$(now)
say "$(rate 'Tweet 1 raw scan (count only)' $((RAW_BLOCKS * 8192)) "$t0" "$t1")"

tid_scope "$slice_start" "$SLICE_BLOCKS" "$SLICE_DIR/scope.tweet"
t0=$(now)
fetch_batch "$HERE/transform/15_Tweet.sql" "$SLICE_DIR/scope.tweet" text "$SLICE_DIR/tweet.txt"
t1=$(now)
bytes=$(stat -c %s "$SLICE_DIR/tweet.txt")
rows=$(wc -l <"$SLICE_DIR/tweet.txt")
say "$(rate 'Tweet 2 transform fetch (output bytes)' "$bytes" "$t0" "$t1")  rows=$rows (heap $(awk -v b="$SLICE_BLOCKS" 'BEGIN { printf "%.1f", b * 8192 / 1e6 / 1 }') MB read)"
say "Tweet 2b source heap read rate during the fetch: $(awk -v b="$((SLICE_BLOCKS * 8192))" -v a="$t0" -v z="$t1" 'BEGIN { printf "%.1f MB/s", b / 1e6 / (z - a) }')"

parts="$(new_q "SELECT part_no FROM mig.tweet_part ORDER BY part_no" | tr '\n' ' ')"
mkdir -p "$SLICE_DIR/route"
t0=$(now)
# shellcheck disable=SC2086
python3 -I "$HERE/tools/tweet-route.py" "$SLICE_DIR/route" $parts <"$SLICE_DIR/tweet.txt" 2>"$SLICE_DIR/route.log"
t1=$(now)
say "$(rate 'Tweet 3 route (tweet-route.py, to files)' "$bytes" "$t0" "$t1")"
cat "$SLICE_DIR"/route/p* >"$SLICE_DIR/tweet.routed"
cols="$(hdr "$HERE/transform/15_Tweet.sql" columns)"
rbytes=$(stat -c %s "$SLICE_DIR/tweet.routed")
t0=$(now)
new_psql -1 -c 'CREATE TABLE seq.tweet_slice (LIKE "Tweet" INCLUDING DEFAULTS)' \
    -c "COPY seq.tweet_slice ($cols) FROM STDIN (FORMAT text, FREEZE)" <"$SLICE_DIR/tweet.routed" >/dev/null
t1=$(now)
say "$(rate 'Tweet 4 target COPY FREEZE (input bytes)' "$rbytes" "$t0" "$t1")"
heap=$(new_q "SELECT pg_relation_size('seq.tweet_slice')")
say "Tweet slice heap on the new DB: $(awk -v b="$heap" 'BEGIN { printf "%.2f GiB", b / 1073741824 }') (old heap $(awk -v b="$((SLICE_BLOCKS * 8192))" 'BEGIN { printf "%.2f GiB", b / 1073741824 }'))"
for def in 'tweet_slice_pk ON seq.tweet_slice ("accountId", "id")' \
    'tweet_slice_created ON seq.tweet_slice ("accountId", "createdAt")' \
    'tweet_slice_reply ON seq.tweet_slice ("collectedAt" DESC, "id" DESC) WHERE "isReply" = true'; do
    t0=$(now)
    new_psql -q -c "CREATE INDEX $def" >/dev/null
    t1=$(now)
    name="${def%% *}"
    isize=$(new_q "SELECT pg_relation_size('seq.$name')")
    say "$(rate "Tweet 5 index $name (heap bytes read)" "$heap" "$t0" "$t1")  index size $(awk -v b="$isize" 'BEGIN { printf "%.2f GiB", b / 1073741824 }')"
done

# id 範囲 (旧 DB の PK を使う走査)。ctid の読み出しとは別の領域から始めて、ページキャッシュの影響を避ける。
id_start="$(printf 'SELECT id FROM "Tweet" WHERE ctid = '"'"'(%s,1)'"'"'::tid;\n' "$((tw_blocks / 8))" | old_psql -At)"
guard_ok
id_end="$(printf 'SELECT id FROM "Tweet" WHERE id >= '"'"'%s'"'"' ORDER BY id OFFSET %s LIMIT 1;\n' "$id_start" "$ID_ROWS" | old_psql -At)"
printf "t.\"id\" >= ''%s'' AND t.\"id\" < ''%s''" "$id_start" "$id_end" >"$SLICE_DIR/scope.tweet.id"
t0=$(now)
fetch_batch "$HERE/transform/15_Tweet.sql" "$SLICE_DIR/scope.tweet.id" text "$SLICE_DIR/tweet.id.txt"
t1=$(now)
say "$(rate 'Tweet 6 id-range fetch (output bytes)' "$(stat -c %s "$SLICE_DIR/tweet.id.txt")" "$t0" "$t1")  rows=$(wc -l <"$SLICE_DIR/tweet.id.txt")"
rm -rf "$SLICE_DIR/route" "$SLICE_DIR"/tweet.*

# ---- AccountLabelLatest ----
al_blocks="$(old_blocks AccountLabelLatest)"
say "== AccountLabelLatest: $al_blocks blocks ($(awk -v b="$al_blocks" 'BEGIN { printf "%.1f", b * 8192 / 1073741824 }') GiB heap)"
raw_start=$((al_blocks / 4))
slice_start=$((al_blocks * 3 / 4))
guard_ok
printf 'SELECT count(*) FROM "AccountLabelLatest" t WHERE ctid >= '"'"'(%s,0)'"'"'::tid AND ctid < '"'"'(%s,0)'"'"'::tid;\n' "$raw_start" "$((raw_start + RAW_BLOCKS))" >"$SLICE_DIR/raw.sql"
t0=$(now)
{ old_prelude; cat "$SLICE_DIR/raw.sql"; echo 'COMMIT;'; } | old_psql -At >/dev/null
t1=$(now)
say "$(rate 'AccountLabelLatest 1 raw scan (count only)' $((RAW_BLOCKS * 8192)) "$t0" "$t1")"

tid_scope "$slice_start" "$SLICE_BLOCKS" "$SLICE_DIR/scope.label"
t0=$(now)
fetch_batch "$HERE/transform/10_label_row.sql" "$SLICE_DIR/scope.label" binary "$SLICE_DIR/label.bin"
t1=$(now)
bytes=$(stat -c %s "$SLICE_DIR/label.bin")
say "$(rate 'AccountLabelLatest 2 transform fetch (output bytes)' "$bytes" "$t0" "$t1")"
say "AccountLabelLatest 2b source heap read rate during the fetch: $(awk -v b="$((SLICE_BLOCKS * 8192))" -v a="$t0" -v z="$t1" 'BEGIN { printf "%.1f MB/s", b / 1e6 / (z - a) }')"
cols="$(hdr "$HERE/transform/10_label_row.sql" columns)"
t0=$(now)
new_psql -1 -c 'CREATE TABLE seq.label_slice (LIKE stg.label_row)' \
    -c "COPY seq.label_slice ($cols) FROM STDIN (FORMAT binary, FREEZE)" <"$SLICE_DIR/label.bin" >/dev/null
t1=$(now)
say "$(rate 'AccountLabelLatest 4 target COPY FREEZE (input bytes)' "$bytes" "$t0" "$t1")"
lrows=$(new_q "SELECT count(*) FROM seq.label_slice")
t0=$(now)
new_psql -q -c 'CREATE TABLE seq.state_slice AS SELECT "accountId", array_agg("lid" ORDER BY "lid") AS lids FROM seq.label_slice GROUP BY 1' >/dev/null
t1=$(now)
say "$(rate 'AccountLabelLatest 5 group by account (stg bytes)' "$bytes" "$t0" "$t1")  rows=$lrows"
rm -rf "$SLICE_DIR"
say "== done"
