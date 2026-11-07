#!/bin/bash
# 切り替えの成功後、master へのマージで公開されたイメージへ載せ替えてから watchtower を再開する。
#
# 使い方: ops/db-rebuild/cutover/reenable-watchtower.sh [--dry-run] [--yes] [check|adopt|enable]
#   check (既定)  compose が指すイメージを pull し、稼働中のコンテナのイメージと比べる (サービスには触れない)
#   adopt         違うサービスを、DATABASE_URL は新 DB のまま、compose が指すイメージへ 1 つずつ載せ替える。
#                 blocker は、起動済みで outbox に未解決が無い場合だけ最後に載せ替える
#   enable        check が全件一致のときだけ watchtower を再開し、一定時間、サービスが再作成されないことを見る
#
# 背景: 切り替えで動かすイメージは feat/db-rebuild のローカルビルドで、ダイジェストは master のマージ後に CI が公開するイメージと異なる (ビルド引数が違う)。
# そのまま watchtower を再開すると、全サービスが予告なく再作成される。
# 先に載せ替えて、稼働中のイメージを watchtower が見るイメージと一致させてから再開する。
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

# master のマージ後に使う。マージ済みの compose.yaml (本番ホストの現行のファイル) の定義で載せ替える。
export COMPOSE_SOURCE=live
parse_flags "$@"
SUB=check
for a in ${ARGS[@]+"${ARGS[@]}"}; do
    case "$a" in
        check | adopt | enable) SUB="$a" ;;
        *) die "unknown argument: $a" ;;
    esac
done
need PROD_COMPOSE_DIR
step_done switched || die "the cutover has not switched; this script is for after a successful cutover"
CFG="$(old_compose_json)"
[ -f "$CFG" ] || die "not found: $CFG"

ref_of() { python3 -I -c 'import json,sys; print(json.load(sys.stdin)["services"][sys.argv[1]].get("image", ""))' "$1" <"$CFG"; }

# 差分のあるサービスを MISMATCH 配列へ入れる
MISMATCH=()
do_check() {
    local svc ref c want have
    MISMATCH=()
    for svc in "${ALL_SERVICES[@]}"; do
        ref="$(ref_of "$svc")"
        if [ -z "$ref" ]; then
            log "$svc: the compose has no image reference (built locally); watchtower cannot update it"
            continue
        fi
        # REENABLE_PULL=0 は、レジストリを使わない自己テスト用
        if [ "${REENABLE_PULL:-1}" = 1 ]; then
            run docker pull --quiet "$ref" >/dev/null || die "cannot pull $ref"
        fi
        c="$(svc_container "$svc")"
        [ -n "$c" ] || {
            log "$svc: no container"
            continue
        }
        want="$(docker image inspect -f '{{.Id}}' "$ref")"
        have="$(docker inspect -f '{{.Image}}' "$c")"
        if [ "$want" = "$have" ]; then
            log "$svc: running image = $ref (watchtower would not redeploy it)"
        else
            log "$svc: running ${have:7:12}, but $ref is ${want:7:12} (watchtower WOULD redeploy it)"
            MISMATCH+=("$svc")
        fi
    done
}

do_adopt() {
    local svc override="$STATE_DIR/compose.adopt.yaml"
    do_check
    [ "${#MISMATCH[@]}" -gt 0 ] || {
        log "nothing to adopt"
        return 0
    }
    if [ "$DRY_RUN" != 1 ]; then
        gen_override adopt | write_state compose.adopt.yaml
        prod_compose -o "$override" config --quiet
    fi
    confirm "Adopting restarts ${MISMATCH[*]} on the images the compose points at (the new DB is kept)."
    for svc in "${START_ORDER[@]}" blocker; do
        [[ " ${MISMATCH[*]} " == *" $svc "* ]] || continue
        if [ "$svc" = blocker ]; then
            step_done blocker_started || {
                log "blocker has not been started yet; adopt it after switch.sh blocker (its container stays on the pinned image until then)"
                continue
            }
            if [ "$DRY_RUN" != 1 ]; then
                read -r unresolved running < <(outbox_state new_psql)
                [ "$unresolved" = 0 ] && [ "$running" = 0 ] || die "blocker has in-flight work (unresolved=$unresolved running=$running); retry between cycles"
            fi
        fi
        run prod_compose -o "$override" up -d --no-deps --no-build --pull never "$svc"
        [ "$DRY_RUN" = 1 ] || sleep "${SETTLE_SECS:-15}"
        [ "$DRY_RUN" = 1 ] || svc_running "$svc" || die "$svc is not running after the adopt"
    done
}

do_enable() {
    do_check
    [ "${#MISMATCH[@]}" = 0 ] || die "these services would be redeployed by watchtower: ${MISMATCH[*]} (run: reenable-watchtower.sh adopt)"
    cat >&2 <<EOF
Before enabling: while watchtower was stopped, OTHER projects' images may have received updates.
Watchtower will redeploy those containers as soon as it starts. If that is not acceptable, run it with
WATCHTOWER_MONITOR_ONLY=true or WATCHTOWER_LABEL_ENABLE first (configured on the watchtower container itself).
EOF
    confirm "Re-enable watchtower ($WATCHTOWER_CONTAINER)."
    local before after policy
    before="$(for svc in "${ALL_SERVICES[@]}"; do docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}' "$(svc_container "$svc")"; done)"
    policy="$(cat "$STATE_DIR/watchtower.$WATCHTOWER_CONTAINER.restart-policy" 2>/dev/null || echo unless-stopped)"
    run docker update --restart="$policy" "$WATCHTOWER_CONTAINER" >/dev/null
    run docker start "$WATCHTOWER_CONTAINER" >/dev/null
    [ "$DRY_RUN" = 1 ] && return 0
    local waited=0 limit="${WATCH_SECS:-300}"
    while [ "$waited" -lt "$limit" ]; do
        sleep 20
        waited=$((waited + 20))
        after="$(for svc in "${ALL_SERVICES[@]}"; do docker inspect -f '{{.Name}} {{.Id}} {{.State.StartedAt}}' "$(svc_container "$svc")"; done)"
        if [ "$before" != "$after" ]; then
            docker stop "$WATCHTOWER_CONTAINER" >/dev/null
            docker update --restart=no "$WATCHTOWER_CONTAINER" >/dev/null
            diff <(echo "$before") <(echo "$after") >&2 || true
            die "a service was recreated after watchtower started; watchtower was stopped again"
        fi
    done
    log "watchtower is running and recreated none of the services in ${limit}s"
}

case "$SUB" in
    check)
        do_check
        [ "${#MISMATCH[@]}" = 0 ] || {
            log "mismatch: ${MISMATCH[*]}"
            exit 1
        }
        ;;
    adopt) do_adopt ;;
    enable) do_enable ;;
esac
