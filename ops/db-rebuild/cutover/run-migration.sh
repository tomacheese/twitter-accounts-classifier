#!/bin/bash
# 旧 DB から新 DB への移行 (load.sh と verify.sh を、本番の設定で呼ぶ)。
#
# 使い方: ops/db-rebuild/cutover/run-migration.sh [--dry-run] [--init-only] [--from prepare|load|restore|verify]
#   --init-only  新 DB の initdb、起動、baseline の適用だけを行う (停止枠の前に、前日までに実施する)
#   --from       途中から再開する。load.sh は step 単位で再開できるため、同じコマンドの再実行でもよい
#
# 時間は目安であり、工程を打ち切らない。経過時間と残りの見積もり (EST_*_SECS、リハーサルの外挿) の合計が
# 停止枠の BUDGET_PERCENT % を超えるときは警告を出して続ける。
# 切り替えの前に止めるのは、正しさの失敗だけ: 検証ゲートの FAIL、旧 DB の読み取り専用の凍結が失われたこと、工程の失敗。
# 止めた場合、旧 DB は読み取り専用のままで、ロールバックは rollback.sh。
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

INIT_ONLY=0
FROM=""
parse_flags "$@"
set -- ${ARGS[@]+"${ARGS[@]}"}
while [ $# -gt 0 ]; do
    case "$1" in
        --init-only) INIT_ONLY=1 ;;
        --from)
            FROM="${2:?--from needs a phase}"
            shift
            ;;
        *) die "unknown argument: $1" ;;
    esac
    shift
done

need NEW_DB_PASSWORD TWEET_VARIANT EST_LOAD_SECS EST_RESTORE_SECS EST_VERIFY_SECS EST_STEADY_SECS
: "${EST_PREPARE_SECS:=600}"
case "$FROM" in "" | prepare | load | restore | verify) ;; *) die "unknown phase for --from: $FROM" ;; esac
state_init

ensure_new_db() {
    if ! docker inspect "$NEW_CONTAINER" >/dev/null 2>&1; then
        log "initializing the new DB (initdb fixes checksums and the C.UTF-8 builtin locale)"
        run "$RB_DIR/initdb.sh"
        run new_db_compose bulk up -d --wait
    elif [ "$(docker inspect -f '{{.State.Running}}' "$NEW_CONTAINER")" != true ]; then
        run new_db_compose bulk up -d --wait
    fi
    [ "$DRY_RUN" = 1 ] && return 0
    if ! step_done steady && [ "$(new_q 'SHOW wal_level')" != minimal ]; then
        die "the new DB is not in the bulk profile (wal_level=$(new_q 'SHOW wal_level')); discard it and rebuild"
    fi
    if [ "$(new_q "SELECT to_regclass('public.\"Account\"') IS NOT NULL")" = f ]; then
        log "applying the baseline ($TWEET_VARIANT)"
        ENUM_UPDATED="${ENUM_UPDATED:-0}" "$RB_DIR/apply-baseline.sh" "$TWEET_VARIANT"
    else
        log "baseline already applied"
    fi
}

if [ "$INIT_ONLY" = 1 ]; then
    ensure_new_db
    log "new DB is initialized with the baseline. Rows: none. Next: preflight.sh, then the stop window"
    exit 0
fi

require_step freeze

banner "old DB must be unchanged since the freeze"
[ "$DRY_RUN" = 1 ] || "$CUT_DIR/freeze.sh" --check

banner "new DB"
ensure_new_db

export_t9_env

psi_sampler() {
    while :; do
        printf '%s %s\n' "$(date -u +%T)" "$(awk '$1 == "full" { print $2, $3 }' /proc/pressure/io 2>/dev/null)" >>"$STATE_DIR/psi.log"
        sleep 30
    done
}
if [ "$DRY_RUN" != 1 ]; then
    psi_sampler &
    PSI_PID=$!
    trap 'kill "$PSI_PID" 2>/dev/null || true' EXIT
fi

PHASES=(prepare load restore verify)
est_of() {
    case "$1" in
        prepare) echo "$EST_PREPARE_SECS" ;;
        load) echo "$EST_LOAD_SECS" ;;
        restore) echo "$EST_RESTORE_SECS" ;;
        verify) echo "$EST_VERIFY_SECS" ;;
    esac
}
# 指定した工程以降 (switch.sh の steady を含む) で、まだ終わっていない工程の見積もりの合計。
est_from() {
    local p total=$EST_STEADY_SECS seen=0
    for p in "${PHASES[@]}"; do
        [ "$p" = "$1" ] && seen=1
        if [ "$seen" = 1 ] && ! step_done "migrate-$p"; then total=$((total + $(est_of "$p"))); fi
    done
    echo "$total"
}
run_phase() { # phase command...
    local ph="$1" rc=0
    shift
    if [ "$DRY_RUN" = 1 ]; then
        log "[dry-run] phase $ph: would report the time projection (remaining estimate $(est_from "$ph")s) and run: $*"
        return 0
    fi
    report_budget "before $ph" "$(est_from "$ph")"
    "$CUT_DIR/freeze.sh" --check-readonly
    phase "migrate: $ph" "$@" || rc=$?
    [ "$rc" = 0 ] || die "phase $ph failed (rc=$rc); fix the cause and re-run with --from $ph"
    mark_done "migrate-$ph"
}

if [ -n "$FROM" ]; then
    unmark verified
    reset=0
    for ph in "${PHASES[@]}"; do
        [ "$ph" != "$FROM" ] || reset=1
        [ "$reset" = 0 ] || unmark "migrate-$ph"
    done
fi
for ph in "${PHASES[@]}"; do
    if step_done "migrate-$ph"; then
        log "phase $ph is already done"
        continue
    fi
    case "$ph" in
        prepare) run_phase prepare "$RB_DIR/load.sh" prepare ;;
        load) run_phase load "$RB_DIR/load.sh" load ;;
        restore) run_phase restore "$RB_DIR/load.sh" restore ;;
        verify)
            unmark verified
            if [ "$DRY_RUN" = 1 ]; then
                log "[dry-run] phase verify: would run verify.sh (gates: counts and hashes, labels, invariants, EXPLAIN, size)"
            elif run_phase verify "$RB_DIR/verify.sh"; then
                cp "$WORK_DIR/verify.tsv" "$STATE_DIR/verify.cutover.tsv"
                mark_done verified
            fi
            ;;
    esac
done

[ "$DRY_RUN" = 1 ] || {
    step_done verified || die "the verification gates did not pass; do not switch"
    log "migration and verification gates passed after $(window_elapsed_secs)s of the window (reference $(window_budget_secs)s)"
    log "Next: switch.sh"
}
