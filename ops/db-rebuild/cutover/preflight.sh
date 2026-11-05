#!/bin/bash
# shellcheck disable=SC2015
# 切り替え前の確認 (T-1 日から前日夜に実行する。停止枠の外)。FAIL が 1 つでもあれば終了コード 1。
#
# 使い方: ops/db-rebuild/cutover/preflight.sh [--dry-run] [--stop-watchtower] [--skip-fio]
#   --stop-watchtower  watchtower を止めて自動再起動も無効にする (指定しないと、動いていれば FAIL)
#   --skip-fio         fio の実測を省く (再実行のとき)
#   --dry-run          状態の記録、イメージの pull とタグ付け、watchtower の停止、fio を行わず、読み取りの検査だけをする
#
# 旧 DB と本番のコンテナには書き込まない。記録するもの (STATE_DIR):
#   old-compose.json, rollback-images.env, new-images.env, others.snapshot, err-baseline.tsv, io-psi.baseline, repo.sha
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

STOP_WATCHTOWER=0
SKIP_FIO=0
parse_flags "$@"
for a in ${ARGS[@]+"${ARGS[@]}"}; do
    case "$a" in
        --stop-watchtower) STOP_WATCHTOWER=1 ;;
        --skip-fio) SKIP_FIO=1 ;;
        *) die "unknown argument: $a" ;;
    esac
done

need PROD_COMPOSE_DIR NEW_IMAGE_CRAWLER NEW_IMAGE_VIEWER NEW_IMAGE_BLOCKER NEW_IMAGE_ANALYZER \
    NEW_DB_PASSWORD NEW_APP_DB_PASSWORD TWEET_VARIANT EST_LOAD_SECS EST_RESTORE_SECS EST_VERIFY_SECS EST_STEADY_SECS
state_init

PASS=0 FAILS=0 WARNS=0
check() { # status name detail
    printf '%-5s %s -- %s\n' "$1" "$2" "$3"
    case "$1" in PASS) PASS=$((PASS + 1)) ;; FAIL) FAILS=$((FAILS + 1)) ;; WARN) WARNS=$((WARNS + 1)) ;; esac
}

banner "tools"
for t in docker python3 awk df stat; do
    command -v "$t" >/dev/null && check PASS "tool $t" "$(command -v "$t")" || check FAIL "tool $t" "not found"
done
docker compose version >/dev/null 2>&1 && check PASS "docker compose" "$(docker compose version --short)" || check FAIL "docker compose" "not available"

banner "settings"
case "$TWEET_VARIANT" in hash | range) check PASS "TWEET_VARIANT" "$TWEET_VARIANT" ;; *) check FAIL "TWEET_VARIANT" "must be hash or range (decided by the rehearsal), got '$TWEET_VARIANT'" ;; esac
if [ "$NEW_DB_USER" = "$APP_DB_ROLE" ]; then
    check FAIL "NEW_DB_USER" "must differ from the app role '$APP_DB_ROLE': the bootstrap superuser cannot be demoted, so REVOKE would never apply to the app"
else
    check PASS "NEW_DB_USER" "admin=$NEW_DB_USER app=$APP_DB_ROLE"
fi

for v in NEW_DB_PASSWORD NEW_APP_DB_PASSWORD; do
    if [[ "${!v}" =~ [@:/#?%[:space:]] ]]; then
        check FAIL "$v characters" "contains a URL-reserved character (@ : / # ? %) or whitespace; compose embeds it in DATABASE_URL"
    else
        check PASS "$v characters" "no URL-reserved characters"
    fi
done
env_value() { sed -n "s/^$1=//p" "$PROD_COMPOSE_DIR/.env" 2>/dev/null | tail -n1 | sed "s/^[\"']//; s/[\"']\$//" || true; }
for pair in DB_OWNER_PASSWORD:NEW_DB_PASSWORD CRAWLER_DB_PASSWORD:NEW_APP_DB_PASSWORD; do
    k="${pair%%:*}" ref="${pair##*:}" cur=""
    cur="$(env_value "$k")"
    if [ -z "$cur" ]; then
        check WARN ".env $k" "not set; add $k with the value of $ref before the master merge (the new compose.yaml requires it)"
    elif [ "$cur" = "${!ref}" ]; then
        check PASS ".env $k" "equals $ref"
    else
        check FAIL ".env $k" "differs from $ref in cutover.env; the post-merge compose would use another password than the cutover set"
    fi
done

banner "production compose"
if prod_compose config --format json >/dev/null 2>&1; then
    check PASS "compose config" "$PROD_COMPOSE_FILES in $PROD_COMPOSE_DIR"
    pin_compose
    if [ "$DRY_RUN" != 1 ]; then snapshot_old_compose; fi
    cfg="$(prod_compose config --format json 2>/dev/null)"
    for svc in "${ALL_SERVICES[@]}" "$OLD_DB_SERVICE"; do
        if python3 -I -c 'import json,sys; sys.exit(0 if sys.argv[1] in json.load(sys.stdin)["services"] else 1)' "$svc" <<<"$cfg"; then
            check PASS "service defined: $svc" ""
        else
            check FAIL "service defined: $svc" "missing from the production compose"
        fi
    done
    url_db="$(python3 -I -c 'import json,sys,urllib.parse as u; c=json.load(sys.stdin)["services"]["crawler"]["environment"]["DATABASE_URL"]; print(u.urlsplit(c).path.lstrip("/"))' <<<"$cfg" 2>/dev/null || true)"
    if [ "$url_db" = "$OLD_DB_NAME" ]; then
        check PASS "OLD_DB_NAME matches crawler DATABASE_URL" "$url_db"
    else
        check FAIL "OLD_DB_NAME matches crawler DATABASE_URL" "OLD_DB_NAME=$OLD_DB_NAME, crawler URL database=$url_db"
    fi
    # 生成できることまで確認する (イメージの変数が揃っていないと失敗する)
    if [ "$DRY_RUN" != 1 ]; then
        export ROLLBACK_IMAGE_CRAWLER=x ROLLBACK_IMAGE_RELABELER=x ROLLBACK_IMAGE_STORAGE_GUARD=x ROLLBACK_IMAGE_VIEWER=x ROLLBACK_IMAGE_BLOCKER=x ROLLBACK_IMAGE_ANALYZER=x
        if gen_override new >/dev/null; then check PASS "override generation" "DATABASE_URL of every service rewrites cleanly"; else check FAIL "override generation" "see the error above"; fi
    fi
else
    check FAIL "compose config" "docker compose config failed for $PROD_COMPOSE_FILES in $PROD_COMPOSE_DIR"
fi

banner "watchtower (auto-deploy hazard)"
mapfile -t wt_all < <(docker ps -a --format '{{.Names}} {{.Image}}' | awk 'tolower($0) ~ /watchtower/ { print $1 }')
if [ "$STOP_WATCHTOWER" = 1 ]; then
    for w in "${wt_all[@]}"; do
        if [ "$(docker inspect -f '{{.State.Running}}' "$w")" = true ] || [ "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$w")" != no ]; then
            if [ "$DRY_RUN" != 1 ] && [ ! -f "$STATE_DIR/watchtower.$w.restart-policy" ]; then
                docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$w" | write_state "watchtower.$w.restart-policy"
            fi
            run docker update --restart=no "$w" >/dev/null
            run docker stop "$w" >/dev/null
        fi
    done
    [ "$DRY_RUN" = 1 ] || sleep 3
fi
if [ "${#wt_all[@]}" = 0 ]; then
    check WARN "watchtower" "no container with 'watchtower' in its name or image was found; confirm there is no other auto-updater"
fi
for w in "${wt_all[@]}"; do
    running="$(docker inspect -f '{{.State.Running}}' "$w")"
    policy="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$w")"
    if [ "$running" = false ] && [ "$policy" = no ]; then
        check PASS "watchtower stopped: $w" "not running, restart policy 'no'"
    elif [ "$DRY_RUN" = 1 ] && [ "$STOP_WATCHTOWER" = 1 ]; then
        check WARN "watchtower: $w" "[dry-run] would stop it (running=$running policy=$policy)"
    else
        check FAIL "watchtower stopped: $w" "running=$running restart-policy=$policy (re-run with --stop-watchtower, then it must be verified stopped)"
    fi
done

banner "images (watchtower cannot be relied on; images are pinned by tag and built from this checkout)"
head_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
for key in CRAWLER VIEWER BLOCKER ANALYZER; do
    var="NEW_IMAGE_$key"
    ref="${!var}"
    last="${ref##*/}"
    if [[ "$ref" != *@sha256:* ]] && { [[ "$last" != *:* ]] || [[ "$last" == *:latest ]]; }; then
        check FAIL "new image $key" "'$ref' is not pinned (use a unique tag or @sha256 digest, never :latest)"
        continue
    fi
    if ! docker image inspect "$ref" >/dev/null 2>&1; then
        if [ "$DRY_RUN" = 1 ]; then
            check WARN "new image $key" "[dry-run] '$ref' is not on this host; build-images.sh or docker pull is needed"
            continue
        fi
        docker pull --quiet "$ref" >/dev/null 2>&1 || {
            check FAIL "new image $key" "'$ref' is neither on this host nor pullable (run build-images.sh, then ship it here)"
            continue
        }
    fi
    id="$(docker image inspect -f '{{.Id}}' "$ref")"
    rev="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref")"
    if [ -z "$rev" ]; then
        check WARN "new image $key" "$ref ($id) has no revision label; cannot confirm it was built from $head_sha"
    elif [ "$rev" != "$head_sha" ]; then
        check FAIL "new image $key" "$ref was built from $rev but this checkout is $head_sha"
    else
        check PASS "new image $key" "$ref ($id) built from $head_sha"
    fi
done

# 旧コードの現行イメージを、watchtower の掃除で消えないようローカルのタグで固定して控える
if step_done switch_started; then
    warn "the cutover already switched; keeping the existing rollback tags"
else
    rollback_env=""
    for svc in "${ALL_SERVICES[@]}"; do
        c="$(svc_container "$svc" || true)"
        if [ -z "$c" ]; then
            # ロールバックで削除した blocker のコンテナのように、コンテナが無い場合は、控え済みのタグがあればそれを使う
            key="$(printf '%s' "$svc" | tr 'a-z-' 'A-Z_')"
            if docker image inspect "tac-rollback/$svc:pre-rebuild" >/dev/null 2>&1; then
                rollback_env+="ROLLBACK_IMAGE_$key=tac-rollback/$svc:pre-rebuild"$'\n'
                check WARN "old image $svc" "no container; keeping the earlier rollback tag tac-rollback/$svc:pre-rebuild"
            else
                check FAIL "old image $svc" "no container found in project $COMPOSE_PROJECT and no earlier rollback tag"
            fi
            continue
        fi
        id="$(docker inspect -f '{{.Image}}' "$c")"
        tag="tac-rollback/$svc:pre-rebuild"
        run docker tag "$id" "$tag"
        key="$(printf '%s' "$svc" | tr 'a-z-' 'A-Z_')"
        rollback_env+="ROLLBACK_IMAGE_$key=$tag"$'\n'
        check PASS "old image $svc" "$id tagged $tag (was $(docker inspect -f '{{.Config.Image}}' "$c"))"
    done
    [ -z "$rollback_env" ] || printf '%s' "$rollback_env" | write_state rollback-images.env
fi

banner "disk (new data, WAL archive, and base backup side by side with the old DB)"
: "${NEED_DATA_GIB:=80}" "${NEED_ARCHIVE_GIB:=10}" "${NEED_BACKUP_GIB:=70}"
nearest() { # 存在する最も近い祖先
    local p="$1"
    while [ ! -e "$p" ] && [ "$p" != / ]; do p="$(dirname "$p")"; done
    echo "$p"
}
declare -A need_by_dev=() path_by_dev=()
for pair in "data:$NEW_DB_DATA_HOST_PATH:$NEED_DATA_GIB" "archive:$NEW_DB_WAL_ARCHIVE_HOST_PATH:$NEED_ARCHIVE_GIB" "backup:$NEW_DB_BACKUP_HOST_PATH:$NEED_BACKUP_GIB"; do
    IFS=: read -r _ path gib <<<"$pair"
    near="$(nearest "$path")"
    dev="$(stat -c %d "$near")"
    need_by_dev[$dev]=$((${need_by_dev[$dev]:-0} + gib))
    path_by_dev[$dev]="${path_by_dev[$dev]:-} $path"
done
for dev in "${!need_by_dev[@]}"; do
    first="$(awk '{ print $1 }' <<<"${path_by_dev[$dev]}")"
    avail_gib=$(($(df --output=avail -B1G "$(nearest "$first")" | tail -n1 | tr -dc 0-9)))
    if [ "$avail_gib" -ge "${need_by_dev[$dev]}" ]; then
        check PASS "disk free" "${avail_gib} GiB free >= ${need_by_dev[$dev]} GiB needed for:${path_by_dev[$dev]}"
    else
        check FAIL "disk free" "${avail_gib} GiB free < ${need_by_dev[$dev]} GiB needed for:${path_by_dev[$dev]} (move the base backup with NEW_DB_BACKUP_HOST_PATH, or free space)"
    fi
done

banner "old DB (must be read-only-able; app services are still running here)"
if old_q 'SELECT 1' >/dev/null 2>&1; then
    check PASS "old DB reachable" "$(old_q 'SELECT split_part(version(), $$ on $$, 1)')"
    check PASS "old DB size" "$(old_q 'SELECT pg_size_pretty(pg_database_size(current_database()))')"
    can_alter="$(old_q "SELECT rolsuper OR EXISTS (SELECT 1 FROM pg_database d WHERE d.datname = current_database() AND pg_get_userbyid(d.datdba) = current_user) FROM pg_roles WHERE rolname = current_user")"
    [ "$can_alter" = t ] && check PASS "ALTER DATABASE allowed" "$OLD_DB_USER is superuser or database owner" || check FAIL "ALTER DATABASE allowed" "$OLD_DB_USER can neither be superuser nor database owner; default_transaction_read_only cannot be set"
    ro="$(old_q 'SHOW default_transaction_read_only')"
    [ "$ro" = off ] && check PASS "old DB currently writable" "default_transaction_read_only=off (freeze.sh will set it)" || check WARN "old DB already read-only" "default_transaction_read_only=$ro (a previous freeze?)"
    [ "$(old_q 'SELECT pg_is_in_recovery()')" = f ] && check PASS "old DB is a primary" "" || check FAIL "old DB is a primary" "it is in recovery"
    read -r unresolved running < <(outbox_state old_admin_psql)
    check PASS "blocker outbox (informational while blocker runs)" "unresolved=$unresolved running_runs=$running (freeze.sh requires 0 and 0 after the blocker is stopped)"
    long="$(old_q "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND xact_start < now() - interval '1 hour' AND pid <> pg_backend_pid()")"
    [ "$long" = 0 ] && check PASS "no transaction older than 1h" "" || check WARN "long transactions on old DB" "$long sessions have a transaction older than 1h; they can hold back vacuum and read consistency"
else
    check FAIL "old DB reachable" "cannot run a query on $OLD_DB_CONTAINER as $OLD_DB_USER"
fi

banner "new DB"
if docker inspect "$NEW_CONTAINER" >/dev/null 2>&1; then
    if [ "$(docker inspect -f '{{.State.Running}}' "$NEW_CONTAINER")" = true ]; then
        check PASS "new DB container" "$NEW_CONTAINER is running ($(new_q 'SHOW wal_level' 2>/dev/null || echo '?'))"
        [ "$(new_q 'SHOW data_checksums' 2>/dev/null || true)" = on ] && check PASS "data_checksums" on || check FAIL "data_checksums" "must be on"
        app_super="$(new_q "SELECT rolsuper FROM pg_roles WHERE rolname = '$APP_DB_ROLE'" 2>/dev/null || true)"
        [ "$app_super" != t ] && check PASS "app role is not a superuser" "${app_super:-role not created yet (switch.sh roles creates it)}" || check FAIL "app role is not a superuser" "$APP_DB_ROLE is a superuser; REVOKE would not apply"
        n_rows="$(new_q 'SELECT count(*) FROM "Account"' 2>/dev/null || echo none)"
        if [ "$n_rows" = 0 ]; then
            check PASS "new DB is empty" "Account rows=0"
        else
            check FAIL "new DB is empty" "Account rows=$n_rows; discard and rebuild it before the real run (CUTOVER.md 9.3)"
        fi
    else
        check WARN "new DB container" "$NEW_CONTAINER exists but is not running"
    fi
else
    check PASS "new DB container" "not created yet; run-migration.sh --init-only creates it (initdb refuses a non-empty directory)"
fi

banner "disk performance (new DB volume; the old volume is not touched)"
if [ "$SKIP_FIO" = 1 ] || [ "$DRY_RUN" = 1 ]; then
    check WARN "fio" "skipped"
else
    mkdir -p "$(dirname "$NEW_DB_DATA_HOST_PATH")"
    fio_out="$("$RB_DIR/fio.sh" "$(dirname "$NEW_DB_DATA_HOST_PATH")" "${FIO_SIZE:-1G}" 2>&1)" || fio_out="FAILED: $fio_out"
    printf '%s\n' "$fio_out" | write_state fio.preflight
    printf '%s\n' "$fio_out"
    case "$fio_out" in FAILED*) check FAIL "fio" "see above" ;; *) check PASS "fio" "recorded in $STATE_DIR/fio.preflight; compare with the rehearsal fio before trusting EST_* values" ;; esac
fi

banner "IO pressure baseline (host-wide, services running)"
if [ -r /proc/pressure/io ]; then
    if [ "$DRY_RUN" != 1 ]; then
        {
            date -u +%FT%TZ
            cat /proc/pressure/io
        } | write_state io-psi.baseline
    fi
    full60="$(awk '$1 == "full" { for (i = 2; i <= NF; i++) if ($i ~ /^avg60=/) { sub("avg60=", "", $i); print $i } }' /proc/pressure/io)"
    check PASS "IO pressure baseline" "full avg60=${full60}% $(grep '^some' /proc/pressure/io | cut -d' ' -f1-4)"
    awk -v p="$full60" -v m="${IO_PSI_START_MAX:-30}" 'BEGIN { exit !(p > m) }' && check WARN "IO pressure is already high" "full avg60=$full60 > ${IO_PSI_START_MAX:-30}; the baseline is not representative" || true
else
    check WARN "IO pressure" "/proc/pressure/io is not readable on this host"
fi

banner "log error baseline (docker logs retention is short; see CUTOVER.md)"
err_baseline=""
for svc in "${ALL_SERVICES[@]}"; do
    c="$(svc_container "$svc" || true)"
    [ -n "$c" ] || continue
    first="$(docker logs --timestamps "$c" 2>&1 | awk 'NR == 1 { print $1 }')"
    errs="$(docker logs "$c" 2>&1 | grep -ci error || true)"
    hours=1
    if [ -n "$first" ] && first_epoch="$(date -d "$first" +%s 2>/dev/null)"; then
        hours=$((($(date +%s) - first_epoch) / 3600))
        [ "$hours" -ge 1 ] || hours=1
    fi
    err_baseline+="$svc"$'\t'"$errs"$'\t'"$hours"$'\n'
    check PASS "error baseline $svc" "$errs error lines over ~${hours}h"
done
printf '%s' "$err_baseline" | write_state err-baseline.tsv

banner "other projects' containers"
if [ "$DRY_RUN" != 1 ]; then others_snapshot | write_state others.snapshot; fi
check PASS "others snapshot" "$(others_snapshot | wc -l) containers recorded (postcheck.sh and rollback.sh verify they are untouched)"

banner "repository"
if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)"
    [ "$branch" = "${CUTOVER_BRANCH:-feat/db-rebuild}" ] && check PASS "branch" "$branch @ $head_sha" || check WARN "branch" "$branch (expected ${CUTOVER_BRANCH:-feat/db-rebuild})"
    [ -z "$(git -C "$REPO_ROOT" status --porcelain)" ] && check PASS "working tree clean" "" || check FAIL "working tree clean" "uncommitted changes; the images and the scripts must come from one commit"
    fetched=1
    run git -C "$REPO_ROOT" fetch --quiet origin || fetched=0
    if git -C "$REPO_ROOT" rev-parse --verify --quiet origin/master >/dev/null; then
        if [ "$fetched" = 0 ]; then
            check WARN "up to date with origin/master" "git fetch failed; the comparison uses a possibly stale origin/master"
        elif git -C "$REPO_ROOT" merge-base --is-ancestor origin/master HEAD; then
            check PASS "up to date with origin/master" ""
        else
            check FAIL "up to date with origin/master" "master has commits not in this branch; merge it and re-run the verification before cutting over"
        fi
    fi
    [ "$DRY_RUN" = 1 ] || printf '%s\n' "$head_sha" | write_state repo.sha
fi

echo
printf 'preflight: %s PASS, %s WARN, %s FAIL\n' "$PASS" "$WARNS" "$FAILS"
if [ "$FAILS" = 0 ]; then
    mark_done preflight
    log "preflight passed. Next: freeze.sh inside the approved stop window"
else
    unmark preflight
    exit 1
fi
