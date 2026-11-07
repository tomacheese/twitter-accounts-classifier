#!/bin/bash
# shellcheck disable=SC2015
# 切り替え後の確認。切り替え直後、1 時間後、24 時間後、72 時間後に実行する。読み取りだけを行う。FAIL があれば終了コード 1。
#
# 使い方: ops/db-rebuild/cutover/postcheck.sh [--since <epoch 秒>] [--full-orphans] [--skip-image-check]
#   --since            確認の対象にする起点 (既定は switch.sh apps の完了時刻)
#   --full-orphans     analyzer の孤児検査 (全件) も実行する。IO を使うため、ピークを避ける
#   --skip-image-check NEW_IMAGE_* との一致確認を省く。reenable-watchtower.sh adopt の後に使う
#
# 主な調整値 (cutover.env): ERR_RATE_FACTOR (既定 2)、ERR_RATE_MIN_PER_HOUR (既定 30)、
#   RELABEL_BASELINE_PER_MIN (切り替え前の relabeler のスループット。未設定なら比較しない)、
#   IO_PSI_FACTOR (既定 2)、IO_PSI_MIN (既定 30)、ORPHAN_SAMPLE_PCT (既定 0.5)、VIEWER_PATHS
set -euo pipefail
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

SINCE=""
FULL_ORPHANS=0
SKIP_IMAGE_CHECK=0
parse_flags "$@"
set -- ${ARGS[@]+"${ARGS[@]}"}
while [ $# -gt 0 ]; do
    case "$1" in
        --since)
            SINCE="${2:?--since needs epoch seconds}"
            shift
            ;;
        --full-orphans) FULL_ORPHANS=1 ;;
        --skip-image-check) SKIP_IMAGE_CHECK=1 ;;
        *) die "unknown argument: $1" ;;
    esac
    shift
done
need PROD_COMPOSE_DIR
[ "$SKIP_IMAGE_CHECK" = 1 ] || need NEW_IMAGE_CRAWLER NEW_IMAGE_VIEWER NEW_IMAGE_BLOCKER NEW_IMAGE_ANALYZER
[ -n "$SINCE" ] || SINCE="$(cat "$STATE_DIR/switched_at" 2>/dev/null)" || die "no switched_at record; pass --since"
: "${ERR_RATE_FACTOR:=2}" "${ERR_RATE_MIN_PER_HOUR:=30}" "${IO_PSI_FACTOR:=2}" "${IO_PSI_MIN:=30}" "${ORPHAN_SAMPLE_PCT:=0.5}" "${POSTCHECK_STMT_TIMEOUT:=120s}"
: "${VIEWER_PATHS:=/api/health / /accounts /labels /system}"

PASS=0 FAILS=0 WARNS=0
check() {
    printf '%-5s %s -- %s\n' "$1" "$2" "$3"
    case "$1" in PASS) PASS=$((PASS + 1)) ;; FAIL) FAILS=$((FAILS + 1)) ;; WARN) WARNS=$((WARNS + 1)) ;; esac
}
new_q() { docker exec -i -e PGOPTIONS="-c statement_timeout=$POSTCHECK_STMT_TIMEOUT" "$NEW_CONTAINER" psql -U "$NEW_DB_USER" -d "$NEW_DB_NAME" -X -q -v ON_ERROR_STOP=1 -At -c "$1" </dev/null; }
hours_since() { awk -v s="$SINCE" -v n="$(date +%s)" 'BEGIN { h = (n - s) / 3600; if (h < 0.25) h = 0.25; printf "%.2f", h }'; }
since_ts() { date -u -d "@$SINCE" +%Y-%m-%dT%H:%M:%SZ; }

echo "postcheck: since $(since_ts) ($(hours_since) h ago)"

banner "services"
if step_done blocker_started; then check_set=("${ALL_SERVICES[@]}"); else check_set=("${START_ORDER[@]}"); fi
for svc in "${check_set[@]}"; do
    c="$(svc_container "$svc" || true)"
    if [ -z "$c" ]; then
        check FAIL "service $svc" "no container"
        continue
    fi
    st="$(docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}} restarts={{.RestartCount}}' "$c")"
    case "$st" in
        "running healthy restarts=0" | "running - restarts=0") check PASS "service $svc" "$st" ;;
        *) check FAIL "service $svc" "$st" ;;
    esac
    if [ "$SKIP_IMAGE_CHECK" != 1 ]; then
        key="$(image_key_of "$svc")"
        ref_var="NEW_IMAGE_$key"
        want="$(docker image inspect -f '{{.Id}}' "${!ref_var}" 2>/dev/null || echo missing)"
        have="$(docker inspect -f '{{.Image}}' "$c")"
        [ "$want" = "$have" ] && check PASS "image $svc" "${!ref_var}" || check FAIL "image $svc" "running $have, pinned $want"
    fi
    url_host="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | sed -n 's/^DATABASE_URL=.*@\([^:/]*\).*/\1/p')"
    [ "$url_host" = "$NEW_DB_HOST" ] && check PASS "DATABASE_URL host $svc" "$url_host" || check FAIL "DATABASE_URL host $svc" "'$url_host', expected '$NEW_DB_HOST'"
done
if ! step_done blocker_started; then
    ! svc_running blocker && check PASS "blocker stays stopped" "until the 24h observation" || check FAIL "blocker stays stopped" "it is running before the observation ended"
fi

banner "error rates (docker logs; the log driver keeps only recent lines, so a short window is representative)"
H="$(hours_since)"
for svc in "${check_set[@]}"; do
    c="$(svc_container "$svc" || true)"
    [ -n "$c" ] || continue
    if ! logs="$(docker logs --since "$(since_ts)" "$c" 2>&1)"; then
        check FAIL "error rate $svc" "docker logs failed"
        continue
    fi
    errs="$(grep -ci error <<<"$logs" || true)"
    base="$(awk -F'\t' -v s="$svc" '$1 == s { printf "%.2f", $2 / $3 }' "$STATE_DIR/err-baseline.tsv" 2>/dev/null || true)"
    : "${base:=0}"
    rate="$(awk -v e="$errs" -v h="$H" 'BEGIN { printf "%.2f", e / h }')"
    limit="$(awk -v b="$base" -v f="$ERR_RATE_FACTOR" -v m="$ERR_RATE_MIN_PER_HOUR" 'BEGIN { l = b * f; if (l < m) l = m; printf "%.2f", l }')"
    if awk -v r="$rate" -v l="$limit" 'BEGIN { exit !(r <= l) }'; then
        check PASS "error rate $svc" "$errs lines, ${rate}/h <= ${limit}/h (baseline ${base}/h)"
    else
        check FAIL "error rate $svc" "$errs lines, ${rate}/h > ${limit}/h (baseline ${base}/h)"
    fi
done
if dblogs="$(docker logs --since "$(since_ts)" "$NEW_CONTAINER" 2>&1)"; then
    denied="$(grep -c 'permission denied' <<<"$dblogs" || true)"
    [ "$denied" = 0 ] && check PASS "new DB log: permission denied" "0" || check FAIL "new DB log: permission denied" "$denied lines (a role or grant is wrong; docker logs $NEW_CONTAINER)"
    pgerr="$(grep -c 'ERROR:' <<<"$dblogs" || true)"
    check PASS "new DB log: ERROR lines" "$pgerr (informational; see docker logs $NEW_CONTAINER | grep ERROR:)"
else
    check FAIL "new DB log" "docker logs $NEW_CONTAINER failed"
fi
dml="$(new_q "SELECT count(*) FROM unnest(ARRAY['AccountLabelState', 'AccountActiveLabel']) t, unnest(ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p WHERE has_table_privilege('$APP_DB_ROLE', format('public.%I', t), p)")"
[ "$dml" = 0 ] && check PASS "app role has no DML on AccountLabelState/AccountActiveLabel" "0 grants" || check FAIL "app role has no DML on AccountLabelState/AccountActiveLabel" "$dml grants (re-run: switch.sh roles)"

banner "relabeler throughput"
per_min="$(new_q "SELECT round(count(*) / 10.0, 1) FROM \"AccountLabelState\" WHERE \"evaluatedAt\" > now() - interval '10 minutes'")"
if [ -n "${RELABEL_BASELINE_PER_MIN:-}" ]; then
    if awk -v n="$per_min" -v b="$RELABEL_BASELINE_PER_MIN" 'BEGIN { exit !(n >= b * 0.25) }'; then
        check PASS "relabel throughput" "${per_min} accounts/min (baseline ${RELABEL_BASELINE_PER_MIN}/min, floor 25%)"
    else
        check FAIL "relabel throughput" "${per_min} accounts/min < 25% of baseline ${RELABEL_BASELINE_PER_MIN}/min"
    fi
else
    check WARN "relabel throughput" "${per_min} accounts/min over the last 10 min (set RELABEL_BASELINE_PER_MIN to judge it)"
fi
written="$(new_q "SELECT count(*) FROM \"AccountLabelState\" WHERE \"evaluatedAt\" > to_timestamp($SINCE)")"
check PASS "accounts evaluated since the switch" "$written"

banner "IO pressure"
if [ -r /proc/pressure/io ]; then
    now60="$(awk '$1 == "full" { for (i = 2; i <= NF; i++) if ($i ~ /^avg60=/) { sub("avg60=", "", $i); print $i } }' /proc/pressure/io)"
    base60="$(awk '$1 == "full" { for (i = 2; i <= NF; i++) if ($i ~ /^avg60=/) { sub("avg60=", "", $i); print $i } }' "$STATE_DIR/io-psi.baseline" 2>/dev/null || true)"
    : "${base60:=0}"
    lim="$(awk -v b="$base60" -v f="$IO_PSI_FACTOR" -v m="$IO_PSI_MIN" 'BEGIN { l = b * f; if (l < m) l = m; print l }')"
    if awk -v n="$now60" -v l="$lim" 'BEGIN { exit !(n <= l) }'; then
        check PASS "IO pressure (full avg60)" "${now60}% <= ${lim}% (baseline ${base60}%)"
    else
        check FAIL "IO pressure (full avg60)" "${now60}% > ${lim}% (baseline ${base60}%)"
    fi
else
    check WARN "IO pressure" "/proc/pressure/io is not readable"
fi

banner "orphans (tables without FK; sampled ${ORPHAN_SAMPLE_PCT}% of pages. --full-orphans for the full scan)"
orphan() { # 名前 SQL (件数を返す)
    local n
    if ! n="$(new_q "$2" 2>&1)"; then
        check FAIL "orphans: $1" "query failed: ${n:0:200}"
        return
    fi
    [ "$n" = 0 ] && check PASS "orphans: $1" "0 in the sample" || check FAIL "orphans: $1" "$n rows"
}
for t in Tweet AccountLabelState AccountActiveLabel AccountLabelChange AccountClassificationLatest AccountClassificationObservation AccountSummaryLatest; do
    if [ "$(new_q "SELECT to_regclass('public.\"$t\"') IS NOT NULL")" != t ]; then
        check WARN "orphans: $t" "table does not exist"
        continue
    fi
    # パーティション表は、親への TABLESAMPLE が使えない場合に備えて全件を LIMIT で切る
    if ! orphan_n="$(new_q "SELECT count(*) FROM \"$t\" TABLESAMPLE SYSTEM ($ORPHAN_SAMPLE_PCT) x WHERE NOT EXISTS (SELECT 1 FROM \"Account\" a WHERE a.id = x.\"accountId\")" 2>/dev/null)"; then
        orphan_n="$(new_q "SELECT count(*) FROM (SELECT \"accountId\" FROM \"$t\" ORDER BY \"accountId\" DESC LIMIT 200000) x WHERE NOT EXISTS (SELECT 1 FROM \"Account\" a WHERE a.id = x.\"accountId\")" 2>&1)" || orphan_n="query failed: ${orphan_n:0:200}"
    fi
    [ "$orphan_n" = 0 ] && check PASS "orphans: $t -> Account" "0 in the sample" || check FAIL "orphans: $t -> Account" "$orphan_n rows"
done
orphan "AccountActiveLabel -> LabelDefinition" \
    "SELECT count(*) FROM \"AccountActiveLabel\" a WHERE NOT EXISTS (SELECT 1 FROM \"LabelDefinition\" d WHERE d.id = a.\"labelDefinitionId\")"
orphan "AccountActiveLabel -> AccountLabelState" \
    "SELECT count(*) FROM (SELECT * FROM \"AccountActiveLabel\" ORDER BY \"accountId\" DESC LIMIT 200000) a WHERE NOT EXISTS (SELECT 1 FROM \"AccountLabelState\" s WHERE s.\"accountId\" = a.\"accountId\")"
if [ "$FULL_ORPHANS" = 1 ]; then
    ac="$(svc_container analyzer)"
    if docker exec "$ac" node "${ORPHAN_SCRIPT:-dist/scripts/orphan-check.js}"; then
        check PASS "orphans: analyzer full scan" "no orphans"
    else
        check FAIL "orphans: analyzer full scan" "reported orphans or failed"
    fi
fi

banner "AccountLabelChange sanity"
future="$(new_q "SELECT count(*) FROM \"AccountLabelChange\" WHERE \"changedAt\" > now() + interval '5 minutes'")"
[ "$future" = 0 ] && check PASS "AccountLabelChange: no future timestamps" "" || check FAIL "AccountLabelChange: no future timestamps" "$future rows"
dist="$(new_q "SELECT coalesce(string_agg(\"changeType\"::text || '=' || n, ' ' ORDER BY \"changeType\"::text), 'none') FROM (SELECT \"changeType\", count(*) AS n FROM \"AccountLabelChange\" WHERE \"changedAt\" >= to_timestamp($SINCE) GROUP BY 1) x")"
check PASS "AccountLabelChange since the switch" "$dist"
# 切り替え後に変化した (アカウント, ラベル) について、最後の記録が added なら有効な行があり、そうでなければ無いこと
viol="$(new_q "
    WITH last AS (
      SELECT DISTINCT ON (\"accountId\", \"labelDefinitionId\") \"accountId\", \"labelDefinitionId\", \"changeType\"
      FROM \"AccountLabelChange\" WHERE \"changedAt\" >= to_timestamp($SINCE)
      ORDER BY \"accountId\", \"labelDefinitionId\", \"changedAt\" DESC, \"id\" DESC)
    SELECT count(*) FROM last l
    LEFT JOIN \"AccountActiveLabel\" a ON a.\"accountId\" = l.\"accountId\" AND a.\"labelDefinitionId\" = l.\"labelDefinitionId\"
    WHERE (l.\"changeType\" = 'added') <> (a.\"accountId\" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM \"AccountLabelChange\" r
                      WHERE r.\"accountId\" = l.\"accountId\" AND r.\"labelDefinitionId\" = l.\"labelDefinitionId\"
                        AND r.\"changedAt\" >= now() - interval '1 minute')")"
[ "$viol" = 0 ] && check PASS "AccountLabelChange agrees with AccountActiveLabel" "0 mismatches" || check FAIL "AccountLabelChange agrees with AccountActiveLabel" "$viol (account, label) pairs disagree"

banner "new DB"
read -r failed archived <<<"$(new_psql -At -F' ' -c "SELECT failed_count, coalesce(extract(epoch FROM now() - last_archived_time)::int, -1) FROM pg_stat_archiver" </dev/null)"
[ "$failed" = 0 ] && check PASS "WAL archiving" "failed_count=0, last archived ${archived}s ago" || check FAIL "WAL archiving" "failed_count=$failed"
csum="$(new_q "SELECT coalesce(sum(checksum_failures), 0) FROM pg_stat_database")"
[ "$csum" = 0 ] && check PASS "checksum failures" "0" || check FAIL "checksum failures" "$csum"
check PASS "database size" "$(new_q 'SELECT pg_size_pretty(pg_database_size(current_database()))')"

banner "viewer pages (through the viewer role)"
vc="$(svc_container viewer)"
for p in $VIEWER_PATHS; do
    res="$(docker exec "$vc" node -e "const t=Date.now();fetch('http://127.0.0.1:3000$p',{signal:AbortSignal.timeout(60000)}).then(r=>{console.log(r.status+' '+(Date.now()-t)+'ms');process.exit(0)}).catch(e=>{console.log('error '+e.message);process.exit(0)})" 2>&1 || true)"
    case "$res" in
        "200 "*) check PASS "viewer $p" "$res" ;;
        *) check FAIL "viewer $p" "$res" ;;
    esac
done

banner "other projects"
others_check && check PASS "other projects' containers" "untouched" || check FAIL "other projects' containers" "changed since the preflight record (diff above)"

echo
printf 'postcheck: %s PASS, %s WARN, %s FAIL\n' "$PASS" "$WARNS" "$FAILS"
[ "$FAILS" = 0 ]
