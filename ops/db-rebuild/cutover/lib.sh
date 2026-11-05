#!/bin/bash
# shellcheck disable=SC2034
# cutover の各スクリプトが共有する関数。直接実行しない。
# 本番ホスト (旧 DB と新 DB のコンテナがあるホスト) の上で実行する前提で、スクリプト内では ssh を使わない。
# 設定は cutover.env (CUTOVER_ENV で場所を変えられる) から読む。cutover.env.example を参照する。
set -euo pipefail

CUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RB_DIR="$(dirname "$CUT_DIR")"
REPO_ROOT="$(cd "$RB_DIR/../.." && pwd)"
CUTOVER_ENV="${CUTOVER_ENV:-$CUT_DIR/cutover.env}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
warn() { log "WARN: $*"; }
die() {
    log "ERROR: $*"
    exit 1
}

[ -f "$CUTOVER_ENV" ] || die "config file not found: $CUTOVER_ENV (copy cutover.env.example and fill it in)"
set -a
# shellcheck source=/dev/null
. "$CUTOVER_ENV"
set +a

need() {
    local v
    for v in "$@"; do
        [ -n "${!v:-}" ] || die "required setting is empty: $v (see cutover.env.example)"
    done
}

: "${COMPOSE_PROJECT:=twitter-accounts-classifier}"
: "${PROD_COMPOSE_FILES:=compose.yaml}"
: "${OLD_DB_SERVICE:=postgres}"
: "${OLD_DB_USER:=crawler}"
: "${NEW_CONTAINER:=tac-new-postgres}"
# NEW_DB_USER は新 DB の管理者 (initdb のブートストラップ) ロール。
# ブートストラップのスーパーユーザーは降格できないため、アプリ用の crawler ロールとは別名にする。
: "${NEW_DB_USER:=tac_owner}"
: "${NEW_DB_NAME:=twitter_accounts_classifier}"
: "${APP_DB_ROLE:=crawler}"
: "${NEW_DB_HOST:=$NEW_CONTAINER}"
: "${STATE_DIR:=/mnt/ssd/twitter-accounts-classifier/cutover-state}"
: "${WORK_DIR:=$STATE_DIR/work}"
: "${WINDOW_MINUTES:=240}"
: "${BUDGET_PERCENT:=70}"
: "${STOP_TIMEOUT:=30}"
: "${WATCHTOWER_CONTAINER:=watchtower}"
: "${OLD_STMT_TIMEOUT:=30min}"
: "${NEW_DB_DATA_HOST_PATH:=/mnt/ssd/twitter-accounts-classifier/postgres-new}"
: "${NEW_DB_WAL_ARCHIVE_HOST_PATH:=/mnt/ssd/twitter-accounts-classifier/postgres-new-wal-archive}"
: "${NEW_DB_BACKUP_HOST_PATH:=/mnt/ssd/twitter-accounts-classifier/postgres-new-backup}"
export NEW_DB_DATA_HOST_PATH NEW_DB_WAL_ARCHIVE_HOST_PATH NEW_DB_BACKUP_HOST_PATH
export NEW_DB_CONTAINER_NAME="$NEW_CONTAINER"
export OLD_DB_SERVICE APP_DB_ROLE NEW_DB_HOST NEW_DB_NAME

# load.sh、verify.sh、apply-baseline.sh が読む変数名に合わせて渡す。
need OLD_DB_CONTAINER OLD_DB_NAME
export OLD_CONTAINER="$OLD_DB_CONTAINER" OLD_DB_USER OLD_DB_NAME NEW_CONTAINER NEW_DB_USER NEW_DB_NAME WORK_DIR

# 停止は blocker を最初に、起動は storage-guard (relabeler の circuit breaker が参照する状態を書く) から。
STOP_ORDER=(blocker crawler relabeler analyzer viewer storage-guard)
START_ORDER=(storage-guard analyzer relabeler crawler viewer)
ALL_SERVICES=(blocker crawler relabeler analyzer viewer storage-guard)

DRY_RUN=0
ASSUME_YES=0
ARGS=()
parse_flags() {
    local a
    for a in "$@"; do
        case "$a" in
            --dry-run | -n) DRY_RUN=1 ;;
            --yes) ASSUME_YES=1 ;;
            *) ARGS+=("$a") ;;
        esac
    done
}

# 変更を伴う外部コマンド。--dry-run では表示だけして実行しない。
run() {
    if [ "$DRY_RUN" = 1 ]; then
        printf '[dry-run] %s\n' "$*" >&2
        return 0
    fi
    "$@"
}

banner() { printf '\n==== %s ====\n' "$*" >&2; }

# ---- 状態 (STATE_DIR) ----
state_init() {
    [ "$DRY_RUN" = 1 ] && return 0
    (umask 077 && mkdir -p "$STATE_DIR/steps" "$WORK_DIR")
    chmod 700 "$STATE_DIR" "$WORK_DIR"
}
state_file() { printf '%s/%s' "$STATE_DIR" "$1"; }
step_done() { [ -f "$STATE_DIR/steps/$1" ]; }
mark_done() {
    [ "$DRY_RUN" = 1 ] && return 0
    state_init
    date -u +%Y-%m-%dT%H:%M:%SZ >"$STATE_DIR/steps/$1"
}
unmark() { [ "$DRY_RUN" = 1 ] || rm -f "$STATE_DIR/steps/$1"; }
# 秘密を含みうる状態ファイルを 0600 で書く。標準入力を内容にする。
write_state() {
    if [ "$DRY_RUN" = 1 ]; then
        cat >/dev/null
        return 0
    fi
    state_init
    (umask 077 && cat >"$STATE_DIR/$1.tmp" && mv "$STATE_DIR/$1.tmp" "$STATE_DIR/$1")
}

phase() {
    local name="$1" t0=$SECONDS rc=0
    shift
    log "=== $name"
    "$@" || rc=$?
    if [ "$DRY_RUN" != 1 ]; then
        state_init
        printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$name" $((SECONDS - t0)) "$rc" >>"$STATE_DIR/timeline.tsv"
    fi
    log "=== $name finished in $((SECONDS - t0))s (rc=$rc)"
    return "$rc"
}

# ---- 停止枠 ----
window_start_epoch() { cat "$STATE_DIR/window_start" 2>/dev/null || true; }
window_elapsed_secs() {
    local s
    s="$(window_start_epoch)"
    [ -n "$s" ] || die "the stop window has not started (run freeze.sh first)"
    echo $(($(date +%s) - s))
}
window_budget_secs() { echo $((WINDOW_MINUTES * 60 * BUDGET_PERCENT / 100)); }

# 経過時間に残りの見積もりを足した値が目安 (停止枠の BUDGET_PERCENT %) を超えるときは警告を出す。止めない。
report_budget() {
    local label="$1" remaining="$2" elapsed budget total
    elapsed="$(window_elapsed_secs)"
    budget="$(window_budget_secs)"
    total=$((elapsed + remaining))
    log "time [$label]: elapsed=${elapsed}s + remaining estimate=${remaining}s = ${total}s (reference ${budget}s = ${BUDGET_PERCENT}% of ${WINDOW_MINUTES}min)"
    if [ "$total" -gt "$budget" ]; then
        warn "the projected duration exceeds the reference (${total}s > ${budget}s). The cutover continues: it stops only for correctness failures"
    fi
}

# ---- compose ----
pin_dir() { printf '%s/pinned-compose' "$STATE_DIR"; }

# 切り替え前の compose ファイルと .env の控え。本番ホストの compose.yaml が master のものに更新されても、
# 旧 DB に対するロールバックは切り替え前の定義で行えるようにする。COMPOSE_SOURCE=live のときだけ現行のファイルを使う。
pin_compose() {
    local pin f live_env
    pin="$(pin_dir)"
    need PROD_COMPOSE_DIR
    live_env="$PROD_COMPOSE_DIR/.env"
    if [ -f "$pin/.pinned" ]; then
        for f in $PROD_COMPOSE_FILES; do
            cmp -s "$PROD_COMPOSE_DIR/$f" "$pin/$f" || warn "the live $f differs from the pinned copy in $pin; cutover and rollback keep using the pinned copy"
        done
        return 0
    fi
    [ "$DRY_RUN" != 1 ] || return 0
    state_init
    (
        umask 077
        mkdir -p "$pin"
        for f in $PROD_COMPOSE_FILES; do cp "$PROD_COMPOSE_DIR/$f" "$pin/$f"; done
        if [ -f "$live_env" ]; then cp "$live_env" "$pin/env"; else : >"$pin/env"; fi
        git -C "$PROD_COMPOSE_DIR" rev-parse HEAD >"$pin/commit" 2>/dev/null || echo unknown >"$pin/commit"
        date -u +%Y-%m-%dT%H:%M:%SZ >"$pin/.pinned"
    )
    log "pinned the production compose files and .env in $pin (commit $(cat "$pin/commit"))"
}

prod_compose() { # [-o override.yaml] args...
    local files=() envopt=() f override="" base pin
    if [ "${1:-}" = -o ]; then
        override="$2"
        shift 2
    fi
    need PROD_COMPOSE_DIR
    pin="$(pin_dir)"
    base="$PROD_COMPOSE_DIR"
    if [ "${COMPOSE_SOURCE:-pinned}" = pinned ] && [ -f "$pin/.pinned" ]; then
        base="$pin"
        envopt=(--env-file "$pin/env")
    fi
    for f in $PROD_COMPOSE_FILES; do files+=(-f "$base/$f"); done
    [ -z "$override" ] || files+=(-f "$override")
    docker compose --project-name "$COMPOSE_PROJECT" --project-directory "$PROD_COMPOSE_DIR" ${envopt[@]+"${envopt[@]}"} "${files[@]}" "$@"
}

svc_container() { prod_compose ps -aq "$1" 2>/dev/null | head -n1; }
svc_running() {
    local c
    c="$(svc_container "$1")"
    [ -n "$c" ] && [ "$(docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null)" = true ]
}
image_key_of() {
    case "$1" in
        crawler | relabeler | storage-guard) echo CRAWLER ;;
        analyzer) echo ANALYZER ;;
        blocker) echo BLOCKER ;;
        viewer) echo VIEWER ;;
        *) die "unknown service: $1" ;;
    esac
}

stop_service() {
    local svc="$1"
    if svc_running "$svc"; then
        log "stopping $svc"
        run prod_compose stop -t "$STOP_TIMEOUT" "$svc"
    else
        log "$svc is already stopped"
    fi
}

# 依存サービス (旧 postgres や migrate) を巻き込まないよう --no-deps と --no-build で起動する。
start_service() { # override svc
    local override="$1" svc="$2"
    log "starting $svc"
    run prod_compose -o "$override" up -d --no-deps --no-build --pull never "$svc"
}

# ---- 新 DB ----
new_psql() { docker exec -i "$NEW_CONTAINER" psql -U "$NEW_DB_USER" -d "$NEW_DB_NAME" -X -q -v ON_ERROR_STOP=1 "$@"; }
new_q() { new_psql -At -c "$1" </dev/null; }
new_db_compose() { # profile args...
    local profile="$1"
    shift
    DB_PROFILE="$profile" docker compose -f "$RB_DIR/compose.new-db.yaml" "$@"
}

# 新 DB コンテナを、アプリのコンテナと同じネットワークへ繋ぐ。コンテナを作り直すと外れるため、作り直した後は再実行する。
app_network() {
    if [ -n "${APP_NETWORK:-}" ]; then
        echo "$APP_NETWORK"
        return
    fi
    docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$OLD_DB_CONTAINER" | awk '{ print $1 }'
}
attach_new_db_network() {
    local net
    net="$(app_network)"
    [ -n "$net" ] || die "could not determine the app network (set APP_NETWORK)"
    if docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$NEW_CONTAINER" | tr ' ' '\n' | grep -qx "$net"; then
        log "$NEW_CONTAINER is already on network $net"
    else
        run docker network connect "$net" "$NEW_CONTAINER"
    fi
}

# ---- 旧 DB ----
# 管理用 (書き込みを伴う) の接続。OLD_ADMIN_PSQL で差し替えられる (ローカルの自己テスト用)。
# 凍結後の旧 DB は default_transaction_read_only=on のため、書き込む接続はセッションごとに off へ上書きする (old_plain_psql は上書きしない)。
old_admin_psql() {
    if [ -n "${OLD_ADMIN_PSQL:-}" ]; then
        eval "$OLD_ADMIN_PSQL" '"$@"'
    else
        docker exec -i -e PGOPTIONS='-c default_transaction_read_only=off' "$OLD_DB_CONTAINER" psql -U "$OLD_DB_USER" -d "$OLD_DB_NAME" -X -q -v ON_ERROR_STOP=1 "$@"
    fi
}
old_plain_psql() {
    if [ -n "${OLD_ADMIN_PSQL:-}" ]; then
        eval "$OLD_ADMIN_PSQL" '"$@"'
    else
        docker exec -i "$OLD_DB_CONTAINER" psql -U "$OLD_DB_USER" -d "$OLD_DB_NAME" -X -q -v ON_ERROR_STOP=1 "$@"
    fi
}
old_q() { old_admin_psql -At -c "$1" </dev/null; }

# load.sh と verify.sh が使う読み取り専用の接続 (eval される文字列)。
# ssh を経由しないため、PGOPTIONS はバックスラッシュを使わず単一引用符で囲む。
old_readonly_psql_cmd() {
    printf "docker exec -i -e PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=%s -c lock_timeout=2s -c idle_in_transaction_session_timeout=15min -c application_name=t11-cutover' %s psql -U %s -d %s -X -q -v ON_ERROR_STOP=1" \
        "$OLD_STMT_TIMEOUT" "$OLD_DB_CONTAINER" "$OLD_DB_USER" "$OLD_DB_NAME"
}

# load.sh と verify.sh へ渡す環境。旧 DB は凍結済みのため、スナップショットを保持するセッションは要らない。
export_t9_env() {
    export NO_SNAPSHOT=1 SHARD="" OLD_GUARD_SSH="" KEEP_UPDATED="${KEEP_UPDATED:-true}"
    : "${OLD_PSQL:=$(old_readonly_psql_cmd)}"
    export OLD_PSQL JOBS="${JOBS:-2}" THROTTLE_SLEEP="${THROTTLE_SLEEP:-0}"
}

# blocker の未解決の outbox (リモート呼び出しが済んだか不明なもの) と、実行中の run の件数を返す。
# 戻り値は "unresolved running" の形式。
outbox_state() { # psql 関数名
    "$1" -At -F' ' -c "SELECT (SELECT count(*) FROM \"BlockOutboxEntry\" WHERE status IN ('pending_remote', 'remote_succeeded')),
                              (SELECT count(*) FROM \"BlockRun\" WHERE status = 'running')" </dev/null
}

# 現行の compose の設定から、サービスの DATABASE_URL のパスワードを取り出す (viewer と analyzer のロール作成に使う)。
svc_db_password() {
    python3 -I -c 'import json,sys,urllib.parse as u; c=json.load(sys.stdin)["services"][sys.argv[1]]["environment"]["DATABASE_URL"]; print(u.unquote(u.urlsplit(c).password or ""))' "$1" <"$(old_compose_json)"
}

# ---- compose の設定と override ----
old_compose_json() { state_file old-compose.json; }
snapshot_old_compose() {
    prod_compose config --format json | write_state old-compose.json
}
gen_override() { # new|old
    python3 -I "$CUT_DIR/tools/gen-override.py" "$1" "$(old_compose_json)"
}

# ---- ほかのプロジェクトのコンテナ ----
# このプロジェクト、新 DB、watchtower 以外のコンテナの ID と起動時刻を並べる (触っていないことの確認用)。
# OTHERS_NAME_REGEX は、対象を名前で絞る自己テスト用の指定 (本番では使わない)。
others_snapshot() {
    local id
    docker ps -aq | while read -r id; do
        docker inspect -f '{{.Id}} {{.Name}} {{.State.Running}} {{.State.StartedAt}} {{.RestartCount}} {{index .Config.Labels "com.docker.compose.project"}}' "$id"
    done | awk -v p="$COMPOSE_PROJECT" -v n="/$NEW_CONTAINER" -v w="/$WATCHTOWER_CONTAINER" -v np="${NEW_DB_PROJECT:-tac-new-db}" -v re="${OTHERS_NAME_REGEX:-}" \
        '$2 != n && $2 != w && $6 != p && $6 != np && (re == "" || $2 ~ re) { print $1, $2, $3, $4, $5 }' | sort -k2
}

# 控え (preflight.sh) と比べて、ほかのプロジェクトのコンテナの ID、名前、起動時刻、稼働状態が変わっていないことを確認する。
others_check() {
    local f="$STATE_DIR/others.snapshot"
    [ -f "$f" ] || {
        warn "no others.snapshot; skipping the other-projects check"
        return 0
    }
    if diff <(awk '{ print $1, $2, $3, $4 }' "$f") <(others_snapshot | awk '{ print $1, $2, $3, $4 }'); then
        log "other projects' containers are untouched"
    else
        return 1
    fi
}

# ---- 確認 ----
confirm() { # message
    [ "$DRY_RUN" = 1 ] && return 0
    [ "$ASSUME_YES" = 1 ] && return 0
    [ -t 0 ] || die "confirmation required but no terminal; re-run with --yes after deciding"
    local ans
    read -r -p "$1 Type 'yes' to continue: " ans
    [ "$ans" = yes ] || die "not confirmed"
}

require_step() {
    local s
    for s in "$@"; do
        if ! step_done "$s"; then
            if [ "$DRY_RUN" = 1 ]; then
                warn "[dry-run] required step not done: $s"
            else
                die "required step not done: $s"
            fi
        fi
    done
}
