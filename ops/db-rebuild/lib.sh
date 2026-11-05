#!/bin/bash
# load.sh、verify.sh、rehearsal.sh が共有する関数。直接実行しない。
#
# 旧 DB は読み取り専用の接続でしか触らない。
#   - 接続時に default_transaction_read_only=on、statement_timeout、lock_timeout を設定する。
#   - すべての問い合わせは、REPEATABLE READ の読み取り専用トランザクションの中で実行する。
#   - 全体で 1 つのスナップショットをエクスポートして共有する (旧 DB が動いていても、件数とハッシュが一致するため)。
#     スナップショットを保持するセッションは、切り替え本番 (旧 DB を停止済み) では不要で、--no-snapshot で省ける。
#
# 主な環境変数 (既定値は本番 Nuts からの読み出し用):
#   OLD_PSQL      旧 DB に接続する psql のコマンド (標準入力から SQL を受け取る)
#   NEW_PSQL      新 DB に接続する psql のコマンド
#   WORK_DIR      作業ディレクトリ (転送の一時ファイル、ログ、スナップショット ID)
#   IO_PSI_LIMIT  旧ホストの IO 圧力 (/proc/pressure/io の full avg60) がこれを超えたら中断する (既定 60)
#   LOAD_LIMIT    旧ホストの 1 分間 load average の上限 (既定 16)。LOAD_LIMIT - 2 を超えている間は問い合わせを待ち、LOAD_ABORT_SECS 待っても下がらなければ中断する
#   OLD_GUARD_SSH 旧ホストの監視に使う ssh 先 (空なら監視しない)
#   OLD_APP_CONTAINERS 監視するアプリコンテナ (空白区切り)

: "${WORK_DIR:=/tmp/db-rebuild-work}"
: "${OLD_SSH:=Nuts}"
: "${OLD_CONTAINER:=twitter-accounts-classifier-postgres-1}"
: "${OLD_DB_USER:=crawler}"
: "${OLD_DB_NAME:=twitter_classifier}"
: "${OLD_STMT_TIMEOUT:=30min}"
: "${NEW_CONTAINER:=tac-new-postgres}"
: "${NEW_DB_USER:=tac_owner}"
: "${NEW_DB_NAME:=twitter_accounts_classifier}"
: "${LOAD_LIMIT:=16}"
: "${THROTTLE_SLEEP:=0}"
: "${SNAPSHOT_MAX_HOURS:=6}"

mkdir -p "$WORK_DIR"

if [ -z "${OLD_PSQL:-}" ]; then
    # ControlMaster で ssh の接続を使い回す。old のコマンドは標準入力の SQL を読む。
    OLD_PSQL="ssh -o ControlMaster=auto -o ControlPath=$WORK_DIR/ssh-%C -o ControlPersist=10m -o ServerAliveInterval=30 $OLD_SSH \
docker exec -i -e PGOPTIONS='-c\ default_transaction_read_only=on\ -c\ statement_timeout=$OLD_STMT_TIMEOUT\ -c\ lock_timeout=2s\ -c\ idle_in_transaction_session_timeout=15min\ -c\ application_name=t9-rehearsal' \
$OLD_CONTAINER psql -U $OLD_DB_USER -d $OLD_DB_NAME -X -q -v ON_ERROR_STOP=1"
fi
: "${NEW_PSQL:=docker exec -i $NEW_CONTAINER psql -U $NEW_DB_USER -d $NEW_DB_NAME -X -v ON_ERROR_STOP=1}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

# 旧 DB へ SQL (標準入力) を流す。引数は psql にそのまま渡す。
# ssh の接続が固まった場合に、無期限に待たないようにする (サーバー側の statement_timeout は届かない)。
old_psql() { timeout "${OLD_CALL_TIMEOUT:-1800}" bash -c "$OLD_PSQL \"\$@\"" _ "$@"; }
new_psql() { eval "$NEW_PSQL" '"$@"'; }

# 単一の問い合わせの結果を、区切りなし・ヘッダなしで返す。
new_q() { new_psql -At -c "$1" </dev/null; }

# スナップショットを使う旧 DB の問い合わせ用の前置き。
old_prelude() {
    printf '\\set ON_ERROR_STOP on\n'
    printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
    if [ -n "${SNAPSHOT_ID:-}" ]; then
        printf "SET TRANSACTION SNAPSHOT '%s';\n" "$SNAPSHOT_ID"
    fi
    printf "SET LOCAL TimeZone = 'UTC';\n"
    printf 'SET LOCAL max_parallel_workers_per_gather = %s;\n' "${OLD_PARALLEL:-0}"
    printf 'SET LOCAL effective_io_concurrency = %s;\n' "${OLD_IO_CONCURRENCY:-16}"
}

# スナップショットを保持するセッションを裏で起動し、SNAPSHOT_ID を設定する。
start_snapshot() {
    [ "${NO_SNAPSHOT:-0}" = 1 ] && return 0
    [ -n "${SNAPSHOT_ID:-}" ] && return 0
    local out="$WORK_DIR/snapshot.out" count=$((SNAPSHOT_MAX_HOURS * 120))
    : >"$out"
    # \watch は c= 回で終わる。ssh が切れて psql が孤立しても、SNAPSHOT_MAX_HOURS 後には必ず終わる。
    {
        printf "SET application_name = 't9-snapshot';\n"
        printf 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n'
        printf 'SELECT pg_export_snapshot();\n'
        printf '\\echo SNAPSHOT_READY\n'
        printf 'SELECT pg_sleep(0) \\watch i=30 c=%s\n' "$count"
    } | old_psql -At >"$out" 2>"$WORK_DIR/snapshot.err" &
    SNAPSHOT_PID=$!
    local i
    for i in $(seq 1 120); do
        if grep -q SNAPSHOT_READY "$out" 2>/dev/null; then
            SNAPSHOT_ID="$(head -n1 "$out")"
            export SNAPSHOT_ID
            SNAPSHOT_OWNER=1
            log "snapshot exported: $SNAPSHOT_ID (held for at most ${SNAPSHOT_MAX_HOURS}h)"
            return 0
        fi
        sleep 1
    done
    die "failed to export a snapshot: $(cat "$WORK_DIR/snapshot.err" 2>/dev/null)"
}

stop_snapshot() {
    [ "${SNAPSHOT_OWNER:-0}" = 1 ] || return 0
    # ssh が切れても旧 DB 側の psql は残るため、バックエンドを明示的に終わらせる。
    printf "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 't9-snapshot' AND pid <> pg_backend_pid();\n" \
        | old_psql -At >/dev/null 2>&1 || true
    kill "${SNAPSHOT_PID:-0}" 2>/dev/null || true
    SNAPSHOT_OWNER=0
    log "snapshot released"
}

# ---- 旧ホストの監視 ----
guard_ok() {
    if [ -f "$WORK_DIR/ABORT" ]; then
        die "aborted by guard: $(cat "$WORK_DIR/ABORT")"
    fi
}

# 旧ホストの状態を 1 回の ssh で取る: load average (1 分)、IO 圧力 (full の avg60)、各アプリコンテナの稼働とエラー行数 (直近 1 分)。
guard_probe() {
    ssh -o ControlMaster=auto -o ControlPath="$WORK_DIR/ssh-guard-%C" -o ControlPersist=2m "$OLD_GUARD_SSH" \
        "echo load \$(cut -d' ' -f1 /proc/loadavg); sed -n 's/^full .*avg60=\\([0-9.]*\\).*/psi \\1/p' /proc/pressure/io; for c in ${OLD_APP_CONTAINERS:-}; do \
           r=\$(docker inspect -f '{{.State.Running}}' \$c 2>/dev/null || echo false); \
           e=\$(docker logs --since 1m \$c 2>&1 | grep -ci error); echo app \$c \$r \$e; done" 2>/dev/null
}

# 旧ホストの load average が LOAD_PAUSE (既定は LOAD_LIMIT - 2) を超えている間は、次の問い合わせを始めずに待つ。
# 旧ホストの load は backfill などで自然に上下するため、超えた瞬間に中断せず、待つことで自分の負荷を引く。
# LOAD_ABORT_SECS (既定 1800) 待っても下がらなければ中断する。監視が動いていないとき (load.now が無いとき) は待たない。
load_wait() {
    local waited=0 pause="${LOAD_PAUSE:-$((LOAD_LIMIT - 2))}" limit="${LOAD_ABORT_SECS:-1800}"
    while [ -f "$WORK_DIR/load.now" ] && awk -v l="$(cat "$WORK_DIR/load.now")" -v m="$pause" 'BEGIN { exit !(l > m) }'; do
        guard_ok
        [ "$waited" -lt "$limit" ] || die "old host load stayed above $pause for ${limit}s (last $(cat "$WORK_DIR/load.now"))"
        sleep 20
        waited=$((waited + 20))
    done
    [ "$waited" -eq 0 ] || echo "$waited" >>"$WORK_DIR/load-wait.secs"
}

start_guard() {
    [ -n "${OLD_GUARD_SSH:-}" ] || return 0
    rm -f "$WORK_DIR/ABORT" "$WORK_DIR/load.now"
    (
        local base err_limit out kind a b c load psi
        base=$(guard_probe | awk '$1 == "app" { s += $4 } END { print s + 0 }')
        err_limit=$((base * 3 + 100))
        while true; do
            sleep 20
            out="$(guard_probe)" || continue
            [ -n "$out" ] || continue
            load=$(awk '$1 == "load" { print $2 }' <<<"$out")
            echo "${load:-0}" >"$WORK_DIR/load.now"
            psi=$(awk '$1 == "psi" { print $2 }' <<<"$out")
            if awk -v p="${psi:-0}" -v m="${IO_PSI_LIMIT:-60}" 'BEGIN { exit !(p > m) }'; then
                echo "old host IO pressure (full avg60) $psi exceeds ${IO_PSI_LIMIT:-60}" >"$WORK_DIR/ABORT"
                break
            fi
            if grep -q '^app .* false ' <<<"$out"; then
                echo "an app container is not running: $(grep '^app .* false ' <<<"$out" | head -n1)" >"$WORK_DIR/ABORT"
                break
            fi
            err=$(awk '$1 == "app" { s += $4 } END { print s + 0 }' <<<"$out")
            if [ "$err" -gt "$err_limit" ]; then
                echo "app error lines in the last minute ($err) exceed $err_limit (baseline $base)" >"$WORK_DIR/ABORT"
                break
            fi
        done
    ) &
    GUARD_PID=$!
}

stop_guard() {
    [ -n "${GUARD_PID:-}" ] && kill "$GUARD_PID" 2>/dev/null || true
    rm -f "$WORK_DIR/load.now"
}

# ---- transform ファイルのヘッダ ----
# 例: hdr transform/11_Account.sql target -> "Account"
hdr() { sed -n "s/^-- $2: *//p" "$1" | head -n1; }
# ヘッダのコメント行を除いた本体 (末尾のセミコロンなし)。
body() { grep -v '^-- ' "$1" | sed -e '$ s/;[[:space:]]*$//'; }

# ---- スコープ (シャード実行と全量実行の切り替え) ----
# shard_scope_sql <列のリスト (カンマ区切り)> <ids ファイル>: ids の配列リテラルでの絞り込み。
scope_by_ids() {
    local cols="$1" ids_file="$2" arr col out=""
    arr="$(paste -sd, "$ids_file")"
    local IFS=,
    for col in $cols; do
        [ -n "$out" ] && out="$out AND "
        # \set の引数の中では '' が 1 つの引用符になる
        out="${out}t.\"$col\" = ANY(''{$arr}''::text[])"
    done
    printf '%s' "$out"
}

: "${JOBS:=2}"
: "${ID_BATCH:=2000}"
: "${CTID_BLOCKS:=131072}"
: "${KEEP_UPDATED:=true}"
: "${FV_SINCE:=2026-08-03 00:00:00}"
: "${HM_SINCE:=2026-09-28 00:00:00}"
: "${SHARD:=}"
: "${ONLY:=}"
: "${FORCE:=0}"

# ---- 旧 DB へ流す問い合わせの共通部品 ----
write_vars() { # 旧 DB に流すスクリプトの \set 群 (scope は別に渡す)
    printf '\\set lmap '"'"'%s'"'"'\n' "$(cat "$WORK_DIR/lmap.json")"
    printf '\\set keep_updated %s\n' "$KEEP_UPDATED"
    printf '\\set fv_since '"'"'%s'"'"'\n' "$FV_SINCE"
    printf '\\set hm_since '"'"'%s'"'"'\n' "$HM_SINCE"
    printf '\\set done_cutoff '"'"'%s'"'"'\n' "$(cat "$WORK_DIR/done_cutoff")"
    printf '\\set part_expr '"'"'%s'"'"'\n' "$(cat "$WORK_DIR/part_expr" 2>/dev/null || echo 0)"
}

# step のバッチ (旧 DB への 1 回の問い合わせの絞り込み条件) を、$WORK_DIR/scope.<name>.<n> に書く。個数を返す。
make_batches() {
    local name="$1" file="$2" scope big from n=0 batch
    scope="$(hdr "$file" scope)"
    big="$(hdr "$file" big)"
    batch="$(hdr "$file" batch || true)"
    from="$(hdr "$file" from || true)"
    [ -n "$from" ] || from="$(hdr "$file" target | tr -d '"')"
    rm -f "$WORK_DIR"/scope."$name".*
    if [ "$scope" = none ]; then
        printf 'true' >"$WORK_DIR/scope.$name.0"
        echo 1
        return
    fi
    if [ -n "$SHARD" ]; then
        if [ "$batch" = all ] || [[ "$scope" == *,* ]]; then
            scope_by_ids "$scope" "$WORK_DIR/shard_ids.txt" >"$WORK_DIR/scope.$name.0"
            echo 1
            return
        fi
        local c
        for c in "$WORK_DIR"/idchunk.*; do
            scope_by_ids "$scope" "$c" >"$WORK_DIR/scope.$name.$n"
            n=$((n + 1))
        done
        echo "$n"
        return
    fi
    if [ "$big" = ctid ]; then
        local blocks lo=0 hi
        blocks="$(printf "SELECT pg_relation_size('\"%s\"') / 8192;\n" "$from" | old_psql -At)"
        while [ "$lo" -lt "$blocks" ]; do
            hi=$((lo + CTID_BLOCKS))
            if [ "$hi" -ge "$blocks" ]; then
                printf "t.ctid >= ''(%s,0)''::tid" "$lo" >"$WORK_DIR/scope.$name.$n"
            else
                printf "t.ctid >= ''(%s,0)''::tid AND t.ctid < ''(%s,0)''::tid" "$lo" "$hi" >"$WORK_DIR/scope.$name.$n"
            fi
            n=$((n + 1))
            lo=$hi
        done
        [ "$n" -gt 0 ] || { printf 'true' >"$WORK_DIR/scope.$name.0"; n=1; }
        echo "$n"
        return
    fi
    printf 'true' >"$WORK_DIR/scope.$name.0"
    echo 1
}

# 旧 DB から 1 バッチ分を取り、$out に受ける (失敗したら 3 回まで再試行)。
fetch_batch() { # file scope_file fmt out
    local file="$1" scope_file="$2" fmt="$3" out="$4" attempt
    for attempt in 1 2 3; do
        load_wait
        if {
            old_prelude
            write_vars
            printf '\\set scope '"'"'%s'"'"'\n' "$(cat "$scope_file")"
            printf 'COPY (\n'
            body "$file"
            printf '\n) TO STDOUT (FORMAT %s);\nCOMMIT;\n' "$fmt"
        } | old_psql >"$out" 2>"$out.err"; then
            if [ "$fmt" = binary ]; then
                [ "$(stat -c %s "$out")" -ge 21 ] && [ "$(tail -c 2 "$out" | od -An -tx1 | tr -d ' ')" = ffff ] && break
            else
                break
            fi
        fi
        log "fetch failed (attempt $attempt): $(head -c 300 "$out.err" 2>/dev/null)"
        sleep $((attempt * 10))
        [ "$attempt" = 3 ] && die "giving up on $file ($scope_file): $(cat "$out.err")"
    done
    rm -f "$out.err"
    [ "$THROTTLE_SLEEP" = 0 ] || sleep "$THROTTLE_SLEEP"
}
