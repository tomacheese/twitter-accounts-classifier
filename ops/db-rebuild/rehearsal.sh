#!/bin/bash
# リハーサル: 1% のシャード (hashtext(Account.id) % 100 = 0) を、本番の旧 DB (読み取り専用) から scratch の新 DB へ流し、
# 変換、検証ゲート、Tweet のパーティション方式の比較、切り替え時間の外挿までを一通り実行する。
#
# 使い方: ops/db-rebuild/rehearsal.sh [hash|range|slice|fio|both]   (既定は both)
#   hash:  HASH(accountId) x 32 で全テーブルを流して検証し、Tweet を計測する
#   range: RANGE(id) で Tweet だけを流し、計測する (ラベルなどは hash の実行で検証済みのため)
#   slice: 表の物理順の逐次読み出しを小さなスライスで計測する (seqslice.sh)。both は最後にこれも実行する
#
# 新 DB のコンテナは、ops/db-rebuild の compose と initdb を使って作る。書き込み先は新 DB だけで、旧 DB には書かない。
# 旧 DB には ssh 先 (OLD_SSH、既定は Nuts) から docker exec で読み取り専用に接続し、監視 (load average とアプリのエラー) を付ける。
#
# 主な環境変数 (lib.sh、load.sh と共通):
#   SHARD (既定 0/100)、WORK_DIR、NEW_CONTAINER、REHEARSAL_DATA_DIR (新 DB を置く場所)、NEW_DB_PORT、NEW_DB_MEM_LIMIT
#   THROTTLE_SLEEP (旧 DB への問い合わせの間隔、既定 1)、JOBS (既定 2)、LOAD_LIMIT (既定 16)
#   PROBE_SEQ=1 で、旧 DB の逐次読み出しの速度を、少量 (各表 1GB) の TID 範囲走査で測る (既定 1)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
: "${SHARD:=0/100}"
: "${THROTTLE_SLEEP:=1}"
: "${JOBS:=2}"
: "${NEW_CONTAINER:=tac-rehearsal-postgres}"
: "${REHEARSAL_DATA_DIR:=/mnt/ssd/t9/rehearsal}"
: "${NEW_DB_PORT:=55434}"
: "${NEW_DB_MEM_LIMIT:=6g}"
: "${OLD_GUARD_SSH=${OLD_SSH:-Nuts}}"
: "${OLD_APP_CONTAINERS:=twitter-accounts-classifier-crawler-1 twitter-accounts-classifier-relabeler-1 twitter-accounts-classifier-analyzer-1 twitter-accounts-classifier-blocker-1 twitter-accounts-classifier-viewer-1 twitter-accounts-classifier-storage-guard-1}"
: "${PROBE_SEQ:=1}"
export SHARD THROTTLE_SLEEP JOBS NEW_CONTAINER OLD_GUARD_SSH OLD_APP_CONTAINERS ENUM_UPDATED="${ENUM_UPDATED:-1}"
export WORK_DIR="${WORK_DIR:-/mnt/ssd/t9/rehearsal-work}"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

MODE="${1:-both}"
TIMELINE="$WORK_DIR/rehearsal.timeline"
touch "$TIMELINE"

phase() { # name command...
    local name="$1" t0=$SECONDS rc=0
    shift
    log "=== $name"
    "$@" || rc=$?
    printf '%s\t%s\t%s\n' "$name" $((SECONDS - t0)) "$rc" >>"$TIMELINE"
    log "=== $name finished in $((SECONDS - t0))s (rc=$rc)"
    return "$rc"
}

compose() {
    NEW_DB_PROJECT=tac-rehearsal NEW_DB_CONTAINER_NAME="$NEW_CONTAINER" NEW_DB_PORT="$NEW_DB_PORT" NEW_DB_MEM_LIMIT="$NEW_DB_MEM_LIMIT" \
        NEW_DB_DATA_HOST_PATH="$REHEARSAL_DATA_DIR/data" NEW_DB_WAL_ARCHIVE_HOST_PATH="$REHEARSAL_DATA_DIR/wal" NEW_DB_BACKUP_HOST_PATH="$REHEARSAL_DATA_DIR/backup" \
        DB_PROFILE=bulk docker compose -f "$HERE/compose.new-db.yaml" "$@"
}

start_new_db() {
    if [ ! -d "$REHEARSAL_DATA_DIR/data" ] || [ -z "$(docker run --rm --user root -v "$REHEARSAL_DATA_DIR/data":/d:ro alpine ls -A /d 2>/dev/null || true)" ]; then
        NEW_DB_PASSWORD="${NEW_DB_PASSWORD:-rehearsal}" NEW_DB_DATA_HOST_PATH="$REHEARSAL_DATA_DIR/data" \
            NEW_DB_WAL_ARCHIVE_HOST_PATH="$REHEARSAL_DATA_DIR/wal" NEW_DB_BACKUP_HOST_PATH="$REHEARSAL_DATA_DIR/backup" "$HERE/initdb.sh"
    fi
    compose up -d
    local i
    for i in $(seq 1 60); do
        new_psql -Atc 'SELECT 1' >/dev/null 2>&1 && break
        sleep 1
    done
    new_q "SELECT 'wal_level=' || current_setting('wal_level') || ' checksums=' || current_setting('data_checksums') || ' ' || version()" >&2
}

seq_probe() { # 旧 DB の逐次読み出し速度。TID 範囲走査で、表の中ほどの 1GB を読む
    local t blocks start t0 t1
    for t in AccountLabelLatest Tweet; do
        blocks="$(printf "SELECT pg_relation_size('\"%s\"') / 8192;\n" "$t" | old_psql -At)"
        start=$((blocks / 2))
        t0=$(date +%s.%N)
        {
            old_prelude
            printf 'SELECT count(*), sum(pg_column_size(t.*)) FROM "%s" t WHERE ctid >= '"'"'(%s,0)'"'"'::tid AND ctid < '"'"'(%s,0)'"'"'::tid;\nCOMMIT;\n' "$t" "$start" "$((start + 131072))"
        } | old_psql -At >/dev/null
        t1=$(date +%s.%N)
        log "seq probe $t: 1 GiB (131072 blocks of $blocks) in $(awk -v a="$t0" -v b="$t1" 'BEGIN { printf "%.1f", b - a }')s"
        printf 'seq-probe %s: 1GiB in %.1fs (table has %s blocks)\n' "$t" "$(awk -v a="$t0" -v b="$t1" 'BEGIN { print b - a }')" "$blocks" >>"$WORK_DIR/seq-probe.txt"
    done
}

run_hash() {
    "$HERE/apply-baseline.sh" hash --reset
    start_snapshot
    start_guard
    export SNAPSHOT_ID
    [ "$PROBE_SEQ" = 1 ] && phase "seq-probe (old DB sequential read)" seq_probe
    # 移行の途中で失敗した場合は、以降の phase を続けない (検証や計測は、投入が済んだ DB に対してだけ意味がある)
    phase "hash: prepare" "$HERE/load.sh" prepare || return 1
    phase "hash: load" "$HERE/load.sh" load || return 1
    phase "hash: restore (indexes, FKs, vacuum)" "$HERE/load.sh" restore || return 1
    local rc=0
    ONLY="${VERIFY_ONLY:-}" phase "hash: verify gates" "$HERE/verify.sh" || rc=$?
    cp "$WORK_DIR/verify.tsv" "$WORK_DIR/verify.hash.tsv" 2>/dev/null || true
    if [ "${BENCH:-1}" = 1 ]; then
        phase "hash: bench" "$HERE/bench-tweet.sh" hash
        # ID 単独の取得のために (id) のインデックスを足した場合 (参考。baseline が (id) を持つ場合は不要)
        new_psql -q -c 'CREATE INDEX IF NOT EXISTS "Tweet_id_idx" ON "Tweet" ("id")' >/dev/null
        phase "hash+id-index: bench" "$HERE/bench-tweet.sh" hash-id-index
    fi
    return "$rc"
}

run_range() {
    "$HERE/apply-baseline.sh" range --reset
    export REUSE_PREPARE=1
    start_snapshot
    start_guard
    export SNAPSHOT_ID
    phase "range: prepare" "$HERE/load.sh" prepare || return 1
    ONLY='^(15_Tweet|tweet_attach)$' phase "range: tweet load and attach" "$HERE/load.sh" load || return 1
    local rc=0
    ONLY='^15_Tweet$' phase "range: tweet verify" "$HERE/verify.sh" || rc=$?
    cp "$WORK_DIR/verify.tsv" "$WORK_DIR/verify.range.tsv" 2>/dev/null || true
    phase "range: bench" "$HERE/bench-tweet.sh" range
    return "$rc"
}

summary() {
    echo
    echo "== timeline (seconds) for shard $SHARD"
    cat "$TIMELINE"
    local scale="${SHARD#*/}"
    echo "== x$scale extrapolation of the load-side phases (naive linear; see the report for the sequential-read correction)"
    awk -F'\t' -v s="$scale" '$1 ~ /prepare|load|restore/ { printf "%-45s %8d s  -> x%d = %.1f h\n", $1, $2, s, $2 * s / 3600 }' "$TIMELINE"
}

trap 'stop_guard; stop_snapshot' EXIT
start_new_db
case "$MODE" in
    hash) run_hash ;;
    range) run_range ;;
    slice) phase "sequential slice measurement" "$HERE/seqslice.sh" ;;
    fio) phase "fio on the new DB volume" "$HERE/fio.sh" "$REHEARSAL_DATA_DIR" 4G ;;
    both)
        run_hash || { summary; die "hash run failed; stopping before the range run"; }
        stop_snapshot
        unset SNAPSHOT_ID
        run_range || { summary; die "range run failed; skipping the slice measurement"; }
        phase "sequential slice measurement" "$HERE/seqslice.sh"
        phase "fio on the new DB volume" "$HERE/fio.sh" "$REHEARSAL_DATA_DIR" 4G
        ;;
    *) die "usage: $0 [hash|range|slice|fio|both]" ;;
esac
summary
