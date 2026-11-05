#!/bin/bash
# 検証ゲート。旧 DB は読み取りだけで、新 DB の内容を旧 DB の変換結果と突き合わせる。
# 使い方: ops/db-rebuild/verify.sh      (load.sh と同じ WORK_DIR、SHARD、SNAPSHOT_ID の環境で実行する)
#
# 全ゲートを実行して、1 つでも FAIL があれば終了コード 1 を返す。結果は $WORK_DIR/verify.tsv にも残る。
# 旧 DB が動いている (リハーサル) 場合は、load.sh と同じスナップショットを使わないと件数が一致しない。
#   rehearsal.sh は同じスナップショットで load.sh と verify.sh を続けて実行する。
#
# ゲート:
#   1. テーブルごとの件数とシャード (hashtext(キー) % 256) 別の内容ハッシュ。旧 DB 側は transform/*.sql の出力、
#      新 DB 側は投入後の表の同じ列 (transform の columns ヘッダが列の対応表)。
#   2. ラベル: 再構築の内容ハッシュ、ラベル × ruleVersion の true 件数と評価不能件数、coverage、乾式の差分 (verify/labels_*.sql)
#   3. 新 DB 側の不変条件、変換漏れ、FK と unique の復元、サイズ (verify/checks.sql)
#   4. 主要クエリの EXPLAIN (Seq Scan が無く、想定のインデックスを使う)
# 環境変数: SAMPLE_MOD (ラベルの内容ハッシュの標本間隔。既定は全量なら 13、シャードなら 1)、
#           SCALE (サイズの外挿倍率。既定はシャードなら M、全量なら 1)、ONLY (対象テーブル名の正規表現)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

RESULTS="$WORK_DIR/verify.tsv"
: >"$RESULTS"
FAILS=0

record() { # gate status detail
    printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"$RESULTS"
    printf '%-4s %s -- %s\n' "$2" "$1" "$3"
    [ "$2" = FAIL ] && FAILS=$((FAILS + 1))
    return 0
}

trap 'stop_guard; stop_snapshot' EXIT
start_snapshot
start_guard
[ -s "$WORK_DIR/lmap.json" ] || new_q "SELECT jsonb_object_agg(old_id, new_id)::text FROM mig.label_map" >"$WORK_DIR/lmap.json"
[ -s "$WORK_DIR/done_cutoff" ] || die "done_cutoff not found in $WORK_DIR; run load.sh prepare first"

if [ -n "$SHARD" ]; then
    : "${SAMPLE_MOD:=1}" "${SCALE:=${SHARD#*/}}"
else
    : "${SAMPLE_MOD:=13}" "${SCALE:=1}"
fi

new_psql -q <<'SQL' >/dev/null
CREATE TABLE IF NOT EXISTS mig.v_old_raw (shard int, n bigint, h numeric);
CREATE TABLE IF NOT EXISTS mig.v_label_old (kind text, shard int, label_key text, rule_version text, value boolean,
  evaluable boolean, n bigint, h_sample numeric, h_all numeric);
CREATE TABLE IF NOT EXISTS mig.v_dry_old (aid bigint, lkey text, h bigint);
SQL

# 旧 DB へ、scope を差し替えて問い合わせを流し、text の結果をファイルへ書く。3 回まで再試行する。
fetch_query() { # sql_file scope_file out
    local sql="$1" scope_file="$2" out="$3" attempt
    for attempt in 1 2 3; do
        load_wait
        if {
            old_prelude
            write_vars
            printf '\\set scope '"'"'%s'"'"'\n' "$(cat "$scope_file")"
            printf '\\set sample_mod %s\n' "$SAMPLE_MOD"
            printf 'COPY (\n'
            body "$sql"
            printf '\n) TO STDOUT;\nCOMMIT;\n'
        } | old_psql >"$out" 2>"$out.err"; then
            rm -f "$out.err"
            [ "$THROTTLE_SLEEP" = 0 ] || sleep "$THROTTLE_SLEEP"
            return 0
        fi
        log "verify fetch failed (attempt $attempt): $(head -c 300 "$out.err")"
        sleep $((attempt * 10))
    done
    die "giving up on $sql ($scope_file)"
}

# ---- 1. テーブルごとの件数と内容ハッシュ ----
qualify_cols() { sed 's/"\([^"]*\)"/q."\1"/g' <<<"$1"; }

verify_table() {
    local file="$1" name target cols alias_cols qcols key router n i out sqlf
    name="$(basename "$file" .sql)"
    target="$(hdr "$file" target)"
    case "$target" in mig.* | stg.label_row) return 0 ;; esac
    [ -z "${ONLY:-}" ] || [[ "$name" =~ $ONLY ]] || return 0
    cols="$(hdr "$file" columns)"
    router="$(hdr "$file" router || true)"
    alias_cols="$cols"
    [ "$router" = tweet ] && alias_cols="part_no, $cols"
    qcols="$(qualify_cols "$cols")"
    key="${qcols%%,*}"
    sqlf="$WORK_DIR/vsql.$name"
    {
        printf 'SELECT (hashtext((%s)::text) %% 256)::int, count(*), sum(hashtextextended(ROW(%s)::text, 0)::numeric)\n' "$key" "$qcols"
        printf 'FROM (\n'
        body "$file"
        printf '\n) AS q(%s)\nGROUP BY 1\n' "$alias_cols"
    } >"$sqlf"
    new_psql -q -c "TRUNCATE mig.v_old_raw" >/dev/null
    n="$(make_batches "v_$name" "$file")"
    for ((i = 0; i < n; i++)); do
        out="$WORK_DIR/vout.$name"
        fetch_query "$sqlf" "$WORK_DIR/scope.v_$name.$i" "$out"
        # 空の入力を docker exec -i の標準入力に渡すと COPY が終わらないことがあるため、空なら流さない。
        [ ! -s "$out" ] || new_psql -q -c "COPY mig.v_old_raw (shard, n, h) FROM STDIN" <"$out" >/dev/null
    done
    rm -f "$sqlf" "$WORK_DIR/vout.$name"
    local res
    res="$(new_psql -At -F'|' -c "
      WITH o AS (SELECT shard, sum(n) AS n, sum(h) AS h FROM mig.v_old_raw GROUP BY shard),
           w AS (SELECT (hashtext(($key)::text) % 256)::int AS shard, count(*) AS n,
                        sum(hashtextextended(ROW($qcols)::text, 0)::numeric) AS h
                 FROM $target AS q GROUP BY 1)
      SELECT (SELECT COALESCE(sum(n), 0) FROM o), (SELECT COALESCE(sum(n), 0) FROM w),
             (SELECT count(*) FROM o FULL JOIN w USING (shard) WHERE o.n IS DISTINCT FROM w.n OR o.h IS DISTINCT FROM w.h)" </dev/null)"
    local old_rows new_rows diff
    IFS='|' read -r old_rows new_rows diff <<<"$res"
    if [ "$diff" = 0 ] && [ "$old_rows" = "$new_rows" ]; then
        record "table $name -> $target: count and 256-shard content hash" PASS "$new_rows rows"
    else
        record "table $name -> $target: count and 256-shard content hash" FAIL "old=$old_rows new=$new_rows shards differ=$diff"
    fi
}

for f in "$HERE"/transform/0[1-9]_*.sql "$HERE"/transform/1[1-9]_*.sql "$HERE"/transform/[2-9][0-9]_*.sql; do
    [ -e "$f" ] && verify_table "$f"
done

# ---- 2. ラベル ----
verify_labels() {
    [ -z "${ONLY:-}" ] || [[ labels =~ $ONLY ]] || return 0
    new_psql -q -c "TRUNCATE mig.v_label_old" -c "TRUNCATE mig.v_dry_old" >/dev/null
    local n i out
    n="$(make_batches v_labels "$HERE/verify/labels_old.sql")"
    for ((i = 0; i < n; i++)); do
        out="$WORK_DIR/vout.labels"
        fetch_query "$HERE/verify/labels_old.sql" "$WORK_DIR/scope.v_labels.$i" "$out"
        [ ! -s "$out" ] || new_psql -q -c "COPY mig.v_label_old FROM STDIN" <"$out" >/dev/null
    done
    # 乾式の差分: 新側で並べ替えた先頭 1000 アカウントを標本にする
    new_q "SELECT \"accountId\" FROM \"AccountLabelState\" ORDER BY hashtext(\"accountId\"::text), \"accountId\" LIMIT 1000" >"$WORK_DIR/dry_ids.txt"
    scope_by_ids accountId "$WORK_DIR/dry_ids.txt" >"$WORK_DIR/scope.v_dry.0"
    fetch_query "$HERE/verify/labels_dry_old.sql" "$WORK_DIR/scope.v_dry.0" "$WORK_DIR/vout.dry"
    [ ! -s "$WORK_DIR/vout.dry" ] || new_psql -q -c "COPY mig.v_dry_old FROM STDIN" <"$WORK_DIR/vout.dry" >/dev/null
    rm -f "$WORK_DIR/vout.labels" "$WORK_DIR/vout.dry"
    emit_gates < <(new_psql -At -F'|' -v sample_mod="$SAMPLE_MOD" <"$HERE/verify/labels_new.sql")
}

emit_gates() {
    local gate status detail
    while IFS='|' read -r gate status detail; do
        case "$status" in PASS | FAIL | INFO) record "$gate" "$status" "$detail" ;; esac
    done
}

verify_labels

# ---- 3. 新 DB 側のゲート ----
if [ -z "${ONLY:-}" ] || [[ checks =~ $ONLY ]]; then
    emit_gates < <(new_psql -At -F'|' -v db_size_limit_gib=70 -v scale="$SCALE" <"$HERE/verify/checks.sql")
    emit_gates < <(new_psql -At -F'|' <"$HERE/verify/checks-work.sql")
fi

# ---- 4. EXPLAIN ----
explain_gate() { # 名前 SQL 禁止する語 期待する語 (空なら省略)
    local name="$1" sql="$2" forbid="$3" expect="$4" plan
    plan="$(new_psql -At -c "SET enable_seqscan = ${EXPLAIN_SEQSCAN:-on}; EXPLAIN (COSTS OFF) $sql" </dev/null)" || { record "explain: $name" FAIL "EXPLAIN failed"; return 0; }
    if grep -q "$forbid" <<<"$plan"; then
        record "explain: $name" FAIL "found '$forbid': $(tr '\n' ';' <<<"$plan" | head -c 300)"
    elif [ -n "$expect" ] && ! grep -qE "$expect" <<<"$plan"; then
        record "explain: $name" FAIL "expected '$expect': $(tr '\n' ';' <<<"$plan" | head -c 300)"
    else
        record "explain: $name" PASS "$(grep -oE '(Index( Only)? Scan|Bitmap Index Scan)[^()]*using [A-Za-z0-9_"]+' <<<"$plan" | head -n 2 | tr '\n' ';')"
    fi
}

if [ -z "${ONLY:-}" ] || [[ explain =~ $ONLY ]]; then
    acct="$(new_q "SELECT \"accountId\" FROM \"AccountLabelState\" ORDER BY \"accountId\" OFFSET 100 LIMIT 1")"
    [ -n "$acct" ] || acct="$(new_q "SELECT \"accountId\" FROM \"AccountLabelState\" ORDER BY \"accountId\" LIMIT 1")"
    lab="$(new_q "SELECT \"labelDefinitionId\" || ',' || \"ruleVersionNo\" FROM \"AccountActiveLabel\" GROUP BY 1 ORDER BY count(*) DESC LIMIT 1")"
    lid="${lab%,*}"
    rvn="${lab#*,}"
    explain_gate "recent 20 tweets of an account" \
        "SELECT \"id\" FROM \"Tweet\" WHERE \"accountId\" = $acct ORDER BY \"createdAt\" DESC LIMIT 20" "Seq Scan" "Index"
    explain_gate "blocker candidates (label, ruleVersionNo, confidence order)" \
        "SELECT \"accountId\" FROM \"AccountActiveLabel\" WHERE \"labelDefinitionId\" = $lid AND \"ruleVersionNo\" = $rvn ORDER BY \"confidence\" DESC, \"accountId\" LIMIT 100" \
        "Seq Scan" "AccountActiveLabel_labelDefinitionId"
    explain_gate "backfill selector (lastRecentTweetsAttemptedAt IS NULL)" \
        "SELECT \"accountId\" FROM \"AccountCrawlState\" WHERE \"lastRecentTweetsAttemptedAt\" IS NULL ORDER BY \"accountId\" LIMIT 100" \
        "Seq Scan" "AccountCrawlState_recent_tweets_unattempted_idx"
    explain_gate "stale scan (AccountLabelState by accountId)" \
        "SELECT \"accountId\" FROM \"AccountLabelState\" WHERE \"accountId\" > 0 AND cardinality(\"versions\") < 1000 ORDER BY \"accountId\" LIMIT 1000" \
        "Seq Scan" "AccountLabelState_pkey"
    explain_gate "AccountLabelState lookup by accountId" \
        "SELECT \"versions\" FROM \"AccountLabelState\" WHERE \"accountId\" = $acct" "Seq Scan" "AccountLabelState_pkey"
fi

echo
echo "verify: $(grep -c "	PASS	" "$RESULTS") PASS, $FAILS FAIL, $(grep -c "	INFO	" "$RESULTS") INFO"
[ "$FAILS" = 0 ]
