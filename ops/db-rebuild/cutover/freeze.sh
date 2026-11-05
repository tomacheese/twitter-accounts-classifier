#!/bin/bash
# 停止枠の開始。サービスを順に止め、旧 DB を読み取り専用にして、件数と最大 ID を記録する。
#
# 使い方: ops/db-rebuild/cutover/freeze.sh [--dry-run] [--yes]
#         ops/db-rebuild/cutover/freeze.sh --check     (旧 DB が freeze 時から変わっていないことの確認。読み取りのみ)
#
# 順序: blocker を最初に止め、実行中の呼び出しが無いこと (outbox の未解決 0、実行中の run 0) を確認してから、
#       残りのサービスを止める。外部へ作用する blocker の停止が確定する前に、ほかを止めない。
# 冪等: 再実行できる。停止済みのサービスは飛ばし、ACL の控えは最初の 1 回だけ書く (REVOKE 後の状態を控えないため)。
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

CHECK_ONLY=0
parse_flags "$@"
for a in ${ARGS[@]+"${ARGS[@]}"}; do
    case "$a" in
        --check) CHECK_ONLY=1 ;;
        *) die "unknown argument: $a" ;;
    esac
done

: "${FREEZE_EXACT_MAX_ROWS:=3000000}"
APP_ROLES="${OLD_APP_ROLES:-crawler analyzer viewer weekly_review}"

# 表ごとの「表名 推定行数 厳密な件数 (大きい表は -) 最大 id (id 列の無い表は -)」。
# 厳密な件数は、推定行数が FREEZE_EXACT_MAX_ROWS 未満の表だけ数える (数億行の表を数えて旧ボリュームに負荷をかけない)。
counts_sql() {
    cat <<SQL
SET statement_timeout = '10min';
SELECT c.relname, c.reltuples::bigint,
       CASE WHEN c.reltuples < $FREEZE_EXACT_MAX_ROWS
            THEN (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
            ELSE '-' END,
       CASE WHEN EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped)
            THEN coalesce((xpath('/row/m/text()', query_to_xml(format('SELECT max(id)::text AS m FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text, 'NULL')
            ELSE '-' END
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
ORDER BY c.relname;
SQL
}
record_counts() { counts_sql | old_admin_psql -At -F$'\t'; }

if [ "$CHECK_ONLY" = 1 ]; then
    state_init
    [ -f "$STATE_DIR/freeze-counts.tsv" ] || die "no freeze record: $STATE_DIR/freeze-counts.tsv"
    # 推定行数 (2 列目) は autovacuum で動くため比べない。
    cut -f1,3,4 "$STATE_DIR/freeze-counts.tsv" >"$WORK_DIR/freeze-counts.expected"
    record_counts | cut -f1,3,4 >"$WORK_DIR/freeze-counts.now"
    if diff -u "$WORK_DIR/freeze-counts.expected" "$WORK_DIR/freeze-counts.now"; then
        log "old DB counts and max ids are unchanged since the freeze"
        exit 0
    fi
    die "the old DB changed after the freeze (diff above)"
fi

need PROD_COMPOSE_DIR
state_init
refuse_if_aborted
require_step preflight

banner "0. window start"
if [ -n "$(window_start_epoch)" ]; then
    log "the window started at $(date -u -d "@$(window_start_epoch)" +%FT%TZ) (elapsed $(window_elapsed_secs)s); resuming"
else
    confirm "This starts the stop window ($WINDOW_MINUTES min) and stops the production services."
    if [ "$DRY_RUN" != 1 ]; then date +%s | write_state window_start; fi
fi

banner "1. watchtower must stay stopped"
mapfile -t wt_all < <(docker ps -a --format '{{.Names}} {{.Image}}' | awk 'tolower($0) ~ /watchtower/ { print $1 }')
for w in "${wt_all[@]}"; do
    [ "$(docker inspect -f '{{.State.Running}}' "$w")" = false ] || die "watchtower '$w' is running; it could redeploy services during the window (preflight.sh --stop-watchtower)"
done
log "no watchtower container is running"

banner "2. stop blocker first and confirm there is no in-flight call"
# サービスの entrypoint は sh のループで SIGTERM を受けても終了せず、停止は STOP_TIMEOUT 後の SIGKILL になる。
# blocker は外部への呼び出しの途中で殺さないよう、実行中の run が無いことを確かめてから止める。
if [ "$DRY_RUN" != 1 ] && svc_running blocker; then
    waited=0
    while :; do
        read -r unresolved running < <(outbox_state old_admin_psql)
        [ "$running" = 0 ] && break
        [ "$waited" -lt "${BLOCKER_IDLE_WAIT_SECS:-900}" ] || die "blocker is mid-cycle (running runs=$running) after ${waited}s; it is not stopped. Decide whether to wait or to stop it anyway"
        log "blocker is mid-cycle (running runs=$running, unresolved outbox=$unresolved); waiting for it to become idle"
        sleep 10
        waited=$((waited + 10))
    done
fi
stop_service blocker
if [ "$DRY_RUN" != 1 ]; then
    svc_running blocker && die "blocker is still running"
    read -r unresolved running < <(outbox_state old_admin_psql)
    if [ "$unresolved" != 0 ] || [ "$running" != 0 ]; then
        old_admin_psql -c "SELECT id, status, \"blockerId\", \"blockedId\", \"createdAt\" FROM \"BlockOutboxEntry\" WHERE status IN ('pending_remote', 'remote_succeeded') ORDER BY \"createdAt\" LIMIT 20" </dev/null >&2 || true
        die "blocker has in-flight work (unresolved outbox=$unresolved, running runs=$running). Do NOT continue. See CUTOVER.md 'blocker has unresolved outbox entries'"
    fi
    log "blocker is stopped; unresolved outbox=0, running runs=0"
fi

banner "3. stop the other services"
for svc in "${STOP_ORDER[@]}"; do
    [ "$svc" = blocker ] && continue
    stop_service "$svc"
done

banner "4. old DB: wait for the remaining client sessions"
if [ "$DRY_RUN" != 1 ]; then
    for _ in $(seq 1 12); do
        n="$(old_q "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()")"
        [ "$n" = 0 ] && break
        log "$n client sessions remain; waiting"
        sleep 5
    done
    if [ "$n" != 0 ]; then
        old_admin_psql -c "SELECT pid, usename, application_name, state, left(query, 80) FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()" </dev/null >&2
        warn "terminating the remaining sessions (all application containers are stopped)"
        old_q "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()" >/dev/null
        sleep 2
        n="$(old_q "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid()")"
        [ "$n" = 0 ] || die "$n sessions are still connected to the old DB"
    fi
    log "no client sessions on the old DB"
fi

banner "5. old DB read-only (database default, and revoke of write privileges from non-owner roles)"
if [ ! -f "$STATE_DIR/old-acl.tsv" ]; then
    # 控えは、REVOKE の前の状態から 1 回だけ作る。列は「REVOKE 文」「元に戻す GRANT 文」。
    acl="$(old_admin_psql -At -F$'\t' </dev/null -c "
        SELECT format('REVOKE %s ON TABLE %I.%I FROM %I', a.privilege_type, n.nspname, c.relname, r.rolname),
               format('GRANT %s ON TABLE %I.%I TO %I', a.privilege_type, n.nspname, c.relname, r.rolname)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        CROSS JOIN LATERAL aclexplode(c.relacl) a
        JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
          AND a.privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
          AND NOT r.rolsuper AND r.oid <> c.relowner
          AND r.rolname = ANY (string_to_array('${APP_ROLES// /,}', ','))
        ORDER BY 1")"
    printf '%s\n' "$acl" | sed '/^$/d' | write_state old-acl.tsv
    log "recorded $(printf '%s\n' "$acl" | sed '/^$/d' | wc -l) write grants in $STATE_DIR/old-acl.tsv"
fi
if [ "$DRY_RUN" = 1 ]; then
    log "[dry-run] ALTER DATABASE \"$OLD_DB_NAME\" SET default_transaction_read_only = on"
    log "[dry-run] would run the REVOKE statements recorded in old-acl.tsv"
else
    old_admin_psql -c "ALTER DATABASE \"$OLD_DB_NAME\" SET default_transaction_read_only = on" </dev/null
    if [ -s "$STATE_DIR/old-acl.tsv" ]; then
        cut -f1 "$STATE_DIR/old-acl.tsv" | sed 's/$/;/' | old_admin_psql >/dev/null
    fi
    # 新しい接続で、書き込みが実際に拒否されることを確認する
    if probe="$(old_plain_psql -c 'CREATE TABLE zz_freeze_probe (i int)' </dev/null 2>&1)"; then
        old_admin_psql -c 'DROP TABLE zz_freeze_probe' </dev/null
        die "the old DB still accepts writes after default_transaction_read_only was set"
    fi
    grep -q 'read-only transaction' <<<"$probe" || die "unexpected error while probing read-only: $probe"
    log "old DB rejects writes: $(grep -o 'cannot execute[^.]*' <<<"$probe" | head -n1)"
fi

banner "6. per-table counts and max ids"
if [ "$DRY_RUN" = 1 ]; then
    log "[dry-run] would record counts into $STATE_DIR/freeze-counts.tsv"
elif [ ! -f "$STATE_DIR/freeze-counts.tsv" ]; then
    record_counts | write_state freeze-counts.tsv
    column -t -s$'\t' "$STATE_DIR/freeze-counts.tsv" >&2 || cat "$STATE_DIR/freeze-counts.tsv" >&2
else
    log "freeze-counts.tsv already exists; verifying that nothing changed"
    "$0" --check
fi

mark_done freeze
log "freeze complete at $(date -u +%FT%TZ); elapsed $(window_elapsed_secs 2>/dev/null || echo 0)s of the ${WINDOW_MINUTES}min window"
log "Next: run-migration.sh"
