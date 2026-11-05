#!/bin/bash
# ロールバック。アプリを旧 DB と、控えておいた旧コードのイメージへ戻す。
#
# 使い方: ops/db-rebuild/cutover/rollback.sh --reason <理由> [--dry-run] [--yes] [--force-late]
#   理由: gate-failed (検証ゲートの再実行が失敗)、errors-1h (切り替え後 1 時間以内にエラーが継続)、
#         abort-before-cutover (切り替え前の中断: 予算超過、ゲート失敗、判断による中止)、manual
#   --force-late  切り替えから 1 時間を過ぎた後にも実行する。切り替え後に新 DB へ書かれたデータは失われる
#
# 守ること:
#   - 旧 blocker を再起動しない。古い outbox の状態を再実行するため。blocker は止めたままにし、起動するコマンドも実行しない。
#   - watchtower は止めたままにする。
#   - 新コードは旧 DB と互換性がないため、旧 DB へはイメージも戻す。
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

REASON=""
FORCE_LATE=0
parse_flags "$@"
set -- ${ARGS[@]+"${ARGS[@]}"}
while [ $# -gt 0 ]; do
    case "$1" in
        --reason)
            REASON="${2:?--reason needs a value}"
            shift
            ;;
        --force-late) FORCE_LATE=1 ;;
        *) die "unknown argument: $1" ;;
    esac
    shift
done
case "$REASON" in gate-failed | errors-1h | abort-before-cutover | manual) ;; *) die "--reason must be one of: gate-failed, errors-1h, abort-before-cutover, manual" ;; esac
need PROD_COMPOSE_DIR
state_init

cat >&2 <<'EOF'
Rollback decision criteria:
  - the gate re-run fails, or
  - errors continue within 1 hour after the cutover.
Data written to the new DB after the cutover does NOT exist in the old DB.
The old blocker is never restarted by this script.
EOF

step_done blocker_started && die "the blocker already ran against the new DB; its outbox records exist only there. Do not roll back automatically: decide manually (see CUTOVER.md)"

SWITCHED=0
step_done switch_started && SWITCHED=1
if [ "$SWITCHED" = 1 ] && [ "$DRY_RUN" != 1 ]; then
    [ -s "$STATE_DIR/switched_at" ] || die "switch_started is recorded but $STATE_DIR/switched_at is missing; cannot tell how long ago the cutover happened. Decide manually"
    since=$(($(date +%s) - $(cat "$STATE_DIR/switched_at")))
    if [ "$since" -gt 3600 ] && [ "$FORCE_LATE" != 1 ]; then
        die "the cutover happened $((since / 60)) min ago; writes since then would be lost. Re-run with --force-late only with the user's explicit approval"
    fi
    log "the cutover happened $((since / 60)) min ago"
fi
[ "$SWITCHED" = 1 ] || log "the services were never pointed at the new DB (stage: before cutover)"
confirm "Roll back to the old DB and the old images (reason: $REASON)."

banner "1. watchtower must stay stopped"
for w in $(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($0) ~ /watchtower/ { print $1 }'); do
    die "watchtower '$w' is running; stop it first. It would redeploy the new images"
done
log "no watchtower container is running"

banner "2. stop the new stack (blocker included; it must not be running)"
for svc in viewer crawler relabeler analyzer storage-guard blocker; do
    stop_service "$svc"
done
[ "$DRY_RUN" = 1 ] || ! svc_running blocker || die "blocker is running"

banner "3. old DB: confirm unchanged, then allow writes again"
if [ "$DRY_RUN" != 1 ]; then
    if [ -f "$STATE_DIR/freeze-counts.tsv" ]; then
        "$CUT_DIR/freeze.sh" --check || warn "the old DB differs from the freeze record; inspect before trusting it"
    fi
    if [ -s "$STATE_DIR/old-acl.tsv" ]; then
        cut -f2 "$STATE_DIR/old-acl.tsv" | sed 's/$/;/' | old_admin_psql >/dev/null
        log "restored the write grants recorded at the freeze"
    fi
    old_admin_psql -c "ALTER DATABASE \"$OLD_DB_NAME\" RESET default_transaction_read_only" </dev/null
    old_admin_psql -At -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 't11-cutover' AND pid <> pg_backend_pid()" </dev/null >/dev/null
    [ "$(old_plain_psql -At -c 'SHOW default_transaction_read_only' </dev/null)" = off ] || die "the old DB is still read-only"
    old_plain_psql -c 'BEGIN; CREATE TABLE zz_rollback_probe (i int); ROLLBACK;' </dev/null || die "the old DB does not accept writes"
    log "old DB accepts writes again"
else
    log "[dry-run] would run the GRANT statements in old-acl.tsv and RESET default_transaction_read_only"
fi

banner "4. start the old stack on the old images (blocker excluded)"
RB_ENV="$STATE_DIR/rollback-images.env"
if [ "$DRY_RUN" = 1 ] && [ ! -f "$RB_ENV" ]; then
    log "[dry-run] rollback-images.env does not exist yet (preflight.sh creates it)"
else
    [ -f "$RB_ENV" ] || die "not found: $RB_ENV (preflight.sh records the old images)"
    set -a
    # shellcheck source=/dev/null
    . "$RB_ENV"
    set +a
    OLD_OVERRIDE="$STATE_DIR/compose.old.yaml"
    if [ "$DRY_RUN" != 1 ]; then
        gen_override old | write_state compose.old.yaml
        prod_compose -o "$OLD_OVERRIDE" config --quiet
    fi
    for svc in "${START_ORDER[@]}"; do
        start_service "$OLD_OVERRIDE" "$svc"
    done
    if [ "$DRY_RUN" != 1 ]; then
        sleep "${SETTLE_SECS:-15}"
        for svc in "${START_ORDER[@]}"; do
            svc_running "$svc" || die "$svc is not running after the rollback"
        done
        # 停止中の blocker のコンテナは、新 DB の設定のまま残ると、誤って起動されたときにどちらの DB を指すか分からない。
        # ログを控えてから削除し、起動は明示的な判断の後に新しく作る。
        bc="$(svc_container blocker)"
        if [ -n "$bc" ]; then
            (umask 077 && docker logs "$bc" >"$STATE_DIR/blocker.last.log" 2>&1) || true
            prod_compose rm -f blocker >/dev/null
            log "removed the stopped blocker container (its log is in $STATE_DIR/blocker.last.log)"
        fi
        ! svc_running blocker || die "blocker is running"
    fi
fi

banner "5. checks"
if [ "$DRY_RUN" != 1 ]; then
    others_check || warn "other projects' containers differ from the preflight record (diff above)"
    # 次の試行のために、今回の記録を履歴へ退避する
    hist="$STATE_DIR/history/$(date -u +%Y%m%dT%H%M%SZ)-$REASON"
    (umask 077 && mkdir -p "$hist")
    for f in steps window_start switched_at ABORTED blocker.last.log verify.cutover.tsv newdb-counts.pre newdb-counts.post compose.new.yaml timeline.tsv freeze-counts.tsv old-acl.tsv; do
        [ ! -e "$STATE_DIR/$f" ] || mv "$STATE_DIR/$f" "$hist/"
    done
    for f in freeze-counts.expected freeze-counts.now; do
        [ ! -e "$WORK_DIR/$f" ] || mv "$WORK_DIR/$f" "$hist/"
    done
    mkdir -p "$STATE_DIR/steps"
    printf '%s\n' "$REASON" >"$hist/reason"
fi
cat >&2 <<EOF

Rolled back (reason: $REASON).
  - Old DB is writable; services run on the old images; the blocker is stopped and must stay stopped.
  - The new DB container ($NEW_CONTAINER) was left running and unused for forensics.
    Discard it before another attempt: docker compose -f $RB_DIR/compose.new-db.yaml down, then empty the three host directories.
  - watchtower is still stopped. Do not re-enable it (see CUTOVER.md).
  - Starting the blocker again is a separate decision for the user (CUTOVER.md, 'blocker after a rollback').
EOF
