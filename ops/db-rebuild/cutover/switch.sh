#!/bin/bash
# 切り替え。検証ゲートを通過した新 DB を定常運用の形にして、アプリを新 DB へ向けて起動する。
#
# 使い方: ops/db-rebuild/cutover/switch.sh [--dry-run] [--yes] [all|roles|steady|gate|finish|apps|blocker]
#   all (既定)  roles → steady → gate → finish → apps。blocker は含まない
#   roles       crawler、viewer、analyzer のロールと権限 (イメージ内の権限同期スクリプト)、REVOKE の確認
#   steady      wal_level=replica へ戻す再起動、WAL アーカイブ、最初の pg_basebackup (switch-to-steady.sh)
#   gate        再起動後の検証 (件数が再起動の前後で一致、新 DB 側の検証ゲートの再実行)
#   finish      mig と stg を落とす
#   apps        storage-guard → analyzer → relabeler → crawler → viewer の順に、新 DB へ向けて起動する
#   blocker     検証後 24 時間の観察を終え、人が確認した後に blocker だけを起動する (--confirm-observed-24h が必須)
#
# DATABASE_URL は apps で初めて切り替わる。
# それ以前の工程が失敗しても、旧 DB は読み取り専用のまま無傷で、アプリは止まったまま。ロールバックは rollback.sh。
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

CONFIRM_24H=0
parse_flags "$@"
SUB=all
for a in ${ARGS[@]+"${ARGS[@]}"}; do
    case "$a" in
        all | roles | steady | gate | finish | apps | blocker) SUB="$a" ;;
        --confirm-observed-24h) CONFIRM_24H=1 ;;
        *) die "unknown argument: $a" ;;
    esac
done

need NEW_DB_PASSWORD NEW_APP_DB_PASSWORD NEW_IMAGE_CRAWLER NEW_IMAGE_VIEWER NEW_IMAGE_BLOCKER NEW_IMAGE_ANALYZER
state_init
export_t9_env

NEW_OVERRIDE="$STATE_DIR/compose.new.yaml"
SCHEMA_FILE="$REPO_ROOT/prisma/baseline/functions.sql"

precheck() {
    require_step freeze verified
    if [ "$DRY_RUN" != 1 ]; then
        report_budget "before the switch" "$EST_STEADY_SECS"
        "$CUT_DIR/freeze.sh" --check
    fi
}

# ---- roles ----
# functions.sql の権限の節 (「ロールを後から作る場合は、作成後にこの節を再実行する」と書かれている) だけを流す。
apply_privilege_section() {
    [ -f "$SCHEMA_FILE" ] || die "not found: $SCHEMA_FILE"
    grep -q '^-- 権限$' "$SCHEMA_FILE" || die "the privilege section marker '-- 権限' is not in $SCHEMA_FILE"
    sed -n '/^-- 権限$/,$p' "$SCHEMA_FILE" | new_psql >/dev/null
}

app_sync_grants() {
    local envf="$STATE_DIR/roles.env" viewer_pw analyzer_pw
    viewer_pw="$(svc_db_password viewer)"
    analyzer_pw="$(svc_db_password analyzer)"
    [ -n "$viewer_pw" ] && [ -n "$analyzer_pw" ] || die "the viewer or analyzer password is empty in the old compose config; ensure_service_role would leave the role NOLOGIN"
    trap 'rm -f "$STATE_DIR/roles.env"' EXIT
    (
        umask 077
        {
            printf 'DATABASE_URL=postgresql://%s@127.0.0.1:5432/%s\n' "$NEW_DB_USER" "$NEW_DB_NAME"
            printf 'PGPASSWORD=%s\n' "$NEW_DB_PASSWORD"
            printf 'CRAWLER_DB_PASSWORD=%s\n' "$NEW_APP_DB_PASSWORD"
            printf 'VIEWER_DB_PASSWORD=%s\n' "$viewer_pw"
            printf 'ANALYZER_DB_PASSWORD=%s\n' "$analyzer_pw"
        } >"$envf"
    )
    local rc=0
    docker run --rm --network "container:$NEW_CONTAINER" --env-file "$envf" --entrypoint bash "$NEW_IMAGE_CRAWLER" \
        -c 'cd /app && bash scripts/db/run-migration-and-sync-grants.sh' || rc=$?
    rm -f "$envf"
    return "$rc"
}

# initdb の pg_hba.conf はループバックしか許可しないため、アプリのコンテナが docker のネットワーク経由で接続できない。
# 接続を許すのは、このデータベースへ繋ぐアプリ用ロールと viewer、analyzer だけにする。
ensure_hba() {
    local line="host $NEW_DB_NAME $APP_DB_ROLE,viewer,analyzer samenet scram-sha-256"
    docker exec -e HBA_LINE="$line" "$NEW_CONTAINER" sh -c 'grep -qxF "$HBA_LINE" /var/lib/postgresql/data/pg_hba.conf || echo "$HBA_LINE" >>/var/lib/postgresql/data/pg_hba.conf'
    new_q 'SELECT pg_reload_conf()' >/dev/null
}

phase_roles() {
    step_done roles && {
        log "roles: already done"
        return 0
    }
    banner "roles: app role, grants, REVOKE"
    run attach_new_db_network
    if [ "$DRY_RUN" = 1 ]; then
        log "[dry-run] would allow $APP_DB_ROLE, viewer and analyzer from the docker network in pg_hba.conf (samenet, scram-sha-256)"
        log "[dry-run] would run scripts/db/run-migration-and-sync-grants.sh from the crawler image (in the DB container's network namespace) as $NEW_DB_USER:"
        log "[dry-run] it creates the $APP_DB_ROLE, viewer and analyzer roles and syncs their grants; then the privilege section of functions.sql is re-applied"
        return 0
    fi
    ensure_hba
    app_sync_grants || die "role sync from the app image failed (see above). The old DB is untouched; nothing was switched"
    apply_privilege_section

    banner "roles: self-check"
    local bad=0
    chk() { # 名前 期待 実際
        if [ "$2" = "$3" ]; then log "ok: $1 = $3"; else
            log "FAIL: $1: expected $2, got $3"
            bad=1
        fi
    }
    chk "app role is not a superuser" t "$(new_q "SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname = '$APP_DB_ROLE'")"
    local t p
    for t in AccountLabelState AccountActiveLabel; do
        for p in INSERT UPDATE DELETE TRUNCATE; do
            chk "$APP_DB_ROLE has no $p on $t" f "$(new_q "SELECT has_table_privilege('$APP_DB_ROLE', '\"$t\"', '$p')")"
        done
    done
    for p in INSERT UPDATE DELETE; do
        chk "$APP_DB_ROLE has $p on Account" t "$(new_q "SELECT has_table_privilege('$APP_DB_ROLE', '\"Account\"', '$p')")"
    done
    chk "$APP_DB_ROLE can execute set_label_result" t "$(new_q "SELECT bool_and(has_function_privilege('$APP_DB_ROLE', oid, 'EXECUTE')) FROM pg_proc WHERE proname = 'set_label_result'")"
    chk "viewer cannot execute set_label_result" f "$(new_q "SELECT bool_or(has_function_privilege('viewer', oid, 'EXECUTE')) FROM pg_proc WHERE proname = 'set_label_result'")"
    # 実際の拒否 (ローカルソケットは trust のため、パスワード無しで app ロールとして接続できる)
    local out
    if out="$(docker exec -i "$NEW_CONTAINER" psql -U "$APP_DB_ROLE" -d "$NEW_DB_NAME" -X -q -c 'DELETE FROM "AccountActiveLabel" WHERE false' 2>&1)"; then
        log "FAIL: a direct DELETE by $APP_DB_ROLE on AccountActiveLabel was allowed"
        bad=1
    else
        grep -q 'permission denied' <<<"$out" && log "ok: direct DELETE by $APP_DB_ROLE is rejected: $out" || {
            log "FAIL: unexpected error: $out"
            bad=1
        }
    fi
    [ "$bad" = 0 ] || die "role self-check failed; do not switch"
    mark_done roles
}

# ---- steady ----
new_counts() { # 全表の厳密な件数 (新 DB、アプリ停止中)
    new_psql -At -F$'\t' <<'SQL'
SET statement_timeout = '30min';
SELECT c.relname, (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
ORDER BY c.relname;
SQL
}

phase_steady() {
    step_done steady && {
        log "steady: already done"
        return 0
    }
    require_step roles
    banner "steady: wal_level=replica, WAL archive, first base backup"
    if [ "$DRY_RUN" = 1 ]; then
        log "[dry-run] would record table counts, then run switch-to-steady.sh as $NEW_DB_USER and re-attach the app network"
        return 0
    fi
    new_counts | write_state newdb-counts.pre
    local wal
    wal="$(new_q 'SHOW wal_level')"
    [ "$wal" = minimal ] || die "wal_level is '$wal', but switch-to-steady.sh needs 'minimal'. If an earlier run restarted the DB but failed later, take the base backup by hand (see CUTOVER.md)"
    phase "steady: switch-to-steady.sh" "$RB_DIR/switch-to-steady.sh"
    attach_new_db_network
    mark_done steady
}

phase_gate() {
    step_done gate && {
        log "gate: already done"
        return 0
    }
    require_step steady
    banner "gate: re-run after the restart (the cutover decision criteria)"
    if [ "$DRY_RUN" = 1 ]; then
        log "[dry-run] would compare table counts before and after the restart and re-run verify.sh (GATE_RERUN=${GATE_RERUN:-quick})"
        return 0
    fi
    new_counts | write_state newdb-counts.post
    diff -u "$STATE_DIR/newdb-counts.pre" "$STATE_DIR/newdb-counts.post" || die "table counts changed across the wal_level restart"
    log "table counts are identical before and after the restart"
    if [ "${GATE_RERUN:-quick}" = full ]; then
        "$RB_DIR/verify.sh" || die "gate re-run (full) failed"
    else
        ONLY='^(checks|explain)$' "$RB_DIR/verify.sh" || die "gate re-run (checks and EXPLAIN) failed"
    fi
    mark_done gate
}

phase_finish() {
    step_done finish && {
        log "finish: already done"
        return 0
    }
    require_step gate
    banner "finish: drop the mig and stg schemas"
    if [ "$DRY_RUN" = 1 ]; then
        log "[dry-run] would run load.sh cleanup"
        return 0
    fi
    "$RB_DIR/load.sh" cleanup
    mark_done finish
}

# ---- apps ----
wait_service() { # svc
    local svc="$1" c st
    for _ in $(seq 1 60); do
        c="$(svc_container "$svc")"
        if [ -n "$c" ]; then
            st="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$c")"
            case "$st" in "running healthy" | "running -") break ;; esac
        fi
        sleep 2
    done
    [ "${st:-}" = "running healthy" ] || [ "${st:-}" = "running -" ] || die "$svc did not become ready (state: ${st:-none})"
    # 起動直後に落ちて再起動を繰り返していないことを見る
    sleep "${SETTLE_SECS:-15}"
    [ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$c")" = "true 0" ] || die "$svc restarted right after the start; check 'docker logs $c'"
    log "$svc is up (container ${c:0:12})"
}

# relabeler は StorageCapacityState が無い、または古いと fail-closed で止まるため、storage-guard の最初の計測を待ってから起動する。
wait_storage_metrics() {
    local since n=0
    since="$(cat "$STATE_DIR/switched_at")"
    for _ in $(seq 1 "${STORAGE_METRICS_WAIT_SECS:-180}"); do
        n="$(new_q "SELECT count(*) FROM \"StorageCapacityState\" WHERE id = 'singleton' AND \"measuredAt\" > to_timestamp($since)")"
        [ "$n" = 1 ] && {
            log "storage-guard has written its first measurement on the new DB"
            return 0
        }
        sleep 1
    done
    die "storage-guard did not write StorageCapacityState within ${STORAGE_METRICS_WAIT_SECS:-180}s; relabeler would stay blocked (docker logs for storage-guard)"
}

phase_apps() {
    step_done switched && {
        log "apps: already done"
        return 0
    }
    require_step finish
    banner "apps: point the services at the new DB"
    run attach_new_db_network
    local w
    for w in $(docker ps --format '{{.Names}} {{.Image}}' | awk 'tolower($0) ~ /watchtower/ { print $1 }'); do
        die "watchtower '$w' is running; stop it first (the services are pinned to local images)"
    done
    if [ "$DRY_RUN" != 1 ]; then
        gen_override new | write_state compose.new.yaml
        prod_compose -o "$NEW_OVERRIDE" config --quiet
        [ -s "$STATE_DIR/switched_at" ] || date +%s | write_state switched_at
    else
        log "[dry-run] would generate $NEW_OVERRIDE and validate it with docker compose config"
    fi
    mark_done switch_started
    # blocker は、古い設定のままの停止中コンテナを残さないよう、起動せずに新しい設定で作り直す
    run prod_compose -o "$NEW_OVERRIDE" up --no-start --no-deps --no-build --pull never blocker
    local svc
    for svc in "${START_ORDER[@]}"; do
        start_service "$NEW_OVERRIDE" "$svc"
        [ "$DRY_RUN" = 1 ] || wait_service "$svc"
        [ "$DRY_RUN" = 1 ] || [ "$svc" != storage-guard ] || wait_storage_metrics
    done
    mark_done switched
    log "services are on the new DB. blocker stays stopped until the 24h observation (switch.sh blocker --confirm-observed-24h)"
    log "Next: postcheck.sh now, again around 1h, 24h and 72h"
}

phase_blocker() {
    require_step switched
    step_done blocker_started && {
        log "blocker: already started"
        return 0
    }
    [ "$CONFIRM_24H" = 1 ] || die "pass --confirm-observed-24h after you have observed the new DB for 24 hours"
    if [ "$DRY_RUN" != 1 ]; then
        local since left
        since=$(($(date +%s) - $(cat "$STATE_DIR/switched_at")))
        left=$((24 * 3600 - since))
        [ "$left" -le 0 ] || die "the blocker must not start before 24h after the switch ($((left / 60)) min left)"
        "$CUT_DIR/postcheck.sh" || die "postcheck failed; the blocker stays stopped"
        read -r unresolved running < <(outbox_state new_psql)
        [ "$unresolved" = 0 ] && [ "$running" = 0 ] || die "the new DB has unresolved outbox entries (unresolved=$unresolved running=$running); the blocker would re-execute them"
    fi
    confirm "Starting the blocker performs real block calls against the external service."
    start_service "$NEW_OVERRIDE" blocker
    [ "$DRY_RUN" = 1 ] || wait_service blocker
    mark_done blocker_started
    log "blocker started on the new DB"
}

case "$SUB" in
    all)
        precheck
        confirm "This switches production to the new DB (hard to revert once writes happen)."
        phase_roles
        phase_steady
        phase_gate
        phase_finish
        phase_apps
        ;;
    roles) precheck && phase_roles ;;
    steady) precheck && phase_steady ;;
    gate) precheck && phase_gate ;;
    finish) precheck && phase_finish ;;
    apps)
        precheck
        confirm "This points the production services at the new DB."
        phase_apps
        ;;
    blocker) phase_blocker ;;
esac
