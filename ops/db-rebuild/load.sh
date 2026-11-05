#!/bin/bash
# 旧 DB から新 DB へ、変換しながらバイナリ COPY のパイプで流し込む。旧 DB は読み取りしかしない。
#
# 使い方: ops/db-rebuild/load.sh [prepare|load|restore|cleanup|all]   (既定は all)
#
# 前提: 新 DB に baseline.sql、tweet-hash.sql または tweet-range.sql、functions.sql が適用済みで、
#       DB_PROFILE=bulk (wal_level=minimal) で起動している。
#
# 環境変数:
#   SHARD            "R/M" なら hashtext(Account.id) % M = R のアカウントだけを流す (リハーサル用)。空なら全量
#   JOBS             同時に流すテーブル数 (既定 2)
#   ONLY             処理する step 名の正規表現 (既定は全部)。例: ONLY='^15_Tweet$'
#   FORCE=1          完了済みの step も再実行する
#   REUSE_PREPARE=1  WORK_DIR に残っているラベル変換表とシャードのアカウント一覧を、旧 DB へ問い合わせ直さずに使う
#   ID_BATCH         シャード実行で 1 回の問い合わせに渡すアカウント数 (既定 2000)
#   CTID_BLOCKS      全量実行で巨大表を分割するブロック数 (既定 131072 = 1GB)
#   THROTTLE_SLEEP   旧 DB への問い合わせの間に挟む秒数 (既定 0)
#   KEEP_UPDATED     AccountLabelChange の changeType='updated' を残すか (既定 true。新 enum に 'updated' が要る)
#   FV_SINCE/HM_SINCE  foreignVideoSourceCount / hasMedia を確定値で埋める collectedAt の下限 (UTC)
#   WORK_DIR、OLD_PSQL、NEW_PSQL など: lib.sh を参照
#
# 再開: step 単位で mig.progress に記録する。途中で止まった step は新側のトランザクションごと巻き戻る。
#       同じコマンドを再実行すると、完了済みの step を飛ばす。新 DB がクラッシュした場合は、復旧せず作り直す。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"

# 全量では、これらのテーブルの制約とインデックスを投入前に外し、投入後に作り直す。
BIG_INDEX_TABLES="Account AccountCrawlState AccountClassificationLatest AccountLabelChange AccountSummaryLatest"
TRIGGER_TABLES="AccountClassificationLatest AccountSummaryLatest AccountActiveLabel"

PHASE="${1:-all}"

cleanup_on_exit() {
    stop_guard
    stop_snapshot
}
trap cleanup_on_exit EXIT

step_done() { [ "$(new_q "SELECT count(*) FROM mig.progress WHERE step = '$1'")" = 1 ]; }
step_enabled() {
    [ -z "$ONLY" ] || [[ "$1" =~ $ONLY ]]
}
record_step() { # step rows seconds
    new_psql -q -c "INSERT INTO mig.progress (step, rows, seconds) VALUES ('$1', $2, $3)
        ON CONFLICT (step) DO UPDATE SET rows = EXCLUDED.rows, seconds = EXCLUDED.seconds, finished_at = now()" >/dev/null
}

# ============================================================
# prepare
# ============================================================
old_text_copy() { # sql ファイル -> 標準出力 (text 形式)。スナップショット内で流す。
    local f="$1"
    {
        old_prelude
        printf 'COPY (\n'
        body "$f"
        printf '\n) TO STDOUT;\nCOMMIT;\n'
    } | old_psql
}

prepare() {
    start_snapshot
    start_guard
    new_psql -q <"$HERE/prepare-new.sql" >/dev/null
    if step_done prepare; then
        log "prepare: already done"
        [ -s "$WORK_DIR/lmap.json" ] || new_q "SELECT jsonb_object_agg(old_id, new_id)::text FROM mig.label_map" >"$WORK_DIR/lmap.json"
        return 0
    fi
    local t0=$SECONDS

    if [ "$KEEP_UPDATED" = true ] && [ "$(new_q "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'AccountLabelChangeType' AND e.enumlabel = 'updated'")" = 0 ]; then
        die "KEEP_UPDATED=true but enum AccountLabelChangeType has no 'updated'. Add it to the baseline, or run with KEEP_UPDATED=false (drops the 'updated' rows)"
    fi

    # 旧 DB の基準時刻 (台帳の 30 日の起点)。スナップショットと同じ時点の now() ではなく、準備時点の時刻でよい。
    printf "SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS');\n" | old_psql -At >"$WORK_DIR/done_cutoff"
    [ -s "$WORK_DIR/done_cutoff" ] || die "could not read the old DB clock"

    # LabelDefinition の変換表
    log "prepare: label map"
    echo '{}' >"$WORK_DIR/lmap.json"
    if [ "${REUSE_PREPARE:-0}" != 1 ] || [ ! -s "$WORK_DIR/label_map.tsv" ]; then
        old_text_copy "$HERE/transform/00_label_map.sql" >"$WORK_DIR/label_map.tsv"
    fi
    [ -s "$WORK_DIR/label_map.tsv" ] || die "label map is empty"
    new_psql -q -1 -c "TRUNCATE mig.label_map" \
        -c "COPY mig.label_map (old_id, new_id, key, description, created_at, current_rule_version, placeholder) FROM STDIN" \
        <"$WORK_DIR/label_map.tsv"
    new_q "SELECT jsonb_object_agg(old_id, new_id)::text FROM mig.label_map" >"$WORK_DIR/lmap.json"
    log "prepare: $(new_q "SELECT count(*) FROM mig.label_map") labels ($(new_q "SELECT count(*) FROM mig.label_map WHERE placeholder") placeholders)"

    # 数字以外の ID の検査 (全量では Account 全件を読むため、シャード実行では対象外)
    if [ -n "$SHARD" ]; then
        local r="${SHARD%/*}" m="${SHARD#*/}"
        log "prepare: selecting shard accounts hashtext(id) % $m = $r"
        if [ "${REUSE_PREPARE:-0}" != 1 ] || [ ! -s "$WORK_DIR/shard_ids.txt" ]; then
            {
                old_prelude
                printf 'COPY (SELECT id FROM "Account" WHERE hashtext(id) %% %s = %s ORDER BY id) TO STDOUT;\nCOMMIT;\n' "$m" "$r"
            } | old_psql >"$WORK_DIR/shard_ids.txt"
        fi
        [ -s "$WORK_DIR/shard_ids.txt" ] || die "shard has no accounts"
        grep -qvE '^[0-9]{1,19}$' "$WORK_DIR/shard_ids.txt" && die "non-numeric account id in the shard"
        new_psql -q -1 -c "TRUNCATE mig.shard_account" -c "COPY mig.shard_account (id) FROM STDIN" <"$WORK_DIR/shard_ids.txt"
        rm -f "$WORK_DIR"/idchunk.*
        split -l "$ID_BATCH" -d -a 5 "$WORK_DIR/shard_ids.txt" "$WORK_DIR/idchunk."
        log "prepare: $(wc -l <"$WORK_DIR/shard_ids.txt") shard accounts"
    else
        {
            old_prelude
            printf 'SELECT count(*) FROM "Account" WHERE id !~ '"'"'^[0-9]{1,19}$'"'"';\nCOMMIT;\n'
        } | old_psql -At | grep -qx 0 || die "non-numeric account ids exist in the old DB"
    fi

    prepare_tweet_partitions
    prepare_new_tables

    new_psql -q -c "INSERT INTO mig.meta (key, value) VALUES
        ('empty_db_size', pg_database_size(current_database())::text),
        ('mode', '${SHARD:-full}'),
        ('keep_updated', '$KEEP_UPDATED'),
        ('snapshot', '${SNAPSHOT_ID:-none}')
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" >/dev/null
    record_step prepare 0 $((SECONDS - t0))
}

# 投入前に、巨大表の制約とインデックス、全表の FK を退避して外し、ACL などのトリガーを止める。
prepare_new_tables() {
    local tables
    tables="$(printf "'%s'," $BIG_INDEX_TABLES)"
    tables="${tables%,}"
    new_psql -q -1 -f /dev/stdin <<SQL >/dev/null
INSERT INTO mig.fk_def (table_name, name, def)
SELECT c.relname, con.conname, format('ALTER TABLE %I ADD CONSTRAINT %I %s', c.relname, con.conname, pg_get_constraintdef(con.oid))
FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
WHERE con.contype = 'f' AND c.relnamespace = 'public'::regnamespace
ON CONFLICT DO NOTHING;

INSERT INTO mig.index_def (table_name, name, kind, def, ord)
SELECT c.relname, i.relname,
       CASE WHEN con.oid IS NULL THEN 'index' ELSE 'constraint' END,
       CASE WHEN con.oid IS NULL
            THEN regexp_replace(pg_get_indexdef(i.oid), '^CREATE (UNIQUE )?INDEX ', 'CREATE \1INDEX IF NOT EXISTS ')
            ELSE format('ALTER TABLE %I ADD CONSTRAINT %I %s', c.relname, con.conname, pg_get_constraintdef(con.oid)) END,
       CASE WHEN con.contype = 'p' THEN 0 WHEN con.oid IS NOT NULL THEN 1 ELSE 2 END
FROM pg_index x
JOIN pg_class c ON c.oid = x.indrelid
JOIN pg_class i ON i.oid = x.indexrelid
LEFT JOIN pg_constraint con ON con.conindid = i.oid AND con.conrelid = c.oid AND con.contype IN ('p', 'u')
WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ($tables)
ON CONFLICT DO NOTHING;

DO \$\$
DECLARE r record;
BEGIN
  FOR r IN SELECT table_name, name FROM mig.fk_def LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', r.table_name, r.name);
  END LOOP;
  FOR r IN SELECT table_name, name, kind FROM mig.index_def ORDER BY ord DESC LOOP
    IF r.kind = 'constraint' THEN
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', r.table_name, r.name);
    ELSE
      EXECUTE format('DROP INDEX IF EXISTS %I', r.name);
    END IF;
  END LOOP;
END
\$\$;
SQL
    local t
    for t in $TRIGGER_TABLES; do
        new_psql -q -c "ALTER TABLE \"$t\" DISABLE TRIGGER USER" >/dev/null
    done
}

# Tweet の子パーティションを記録して切り離し、削除する。投入時に同一トランザクションで作り直し、投入後に attach する。
prepare_tweet_partitions() {
    if [ "$(new_q "SELECT count(*) FROM mig.tweet_part")" != 0 ]; then
        return 0
    fi
    new_psql -q -1 -f /dev/stdin <<'SQL' >/dev/null
INSERT INTO mig.tweet_part (part_no, leaf, bound, reloptions)
SELECT CASE WHEN p.partstrat = 'h' THEN (regexp_match(b.bound, 'remainder (\d+)'))[1]::int
            ELSE (row_number() OVER (ORDER BY CASE WHEN b.bound ~ 'FROM \(MINVALUE\)' THEN -9223372036854775807
                                                   ELSE (regexp_match(b.bound, 'FROM \(''?(-?\d+)''?\)'))[1]::bigint END) - 1)::int END,
       b.leaf, b.bound, b.reloptions
FROM (
  SELECT c.relname AS leaf, pg_get_expr(c.relpartbound, c.oid) AS bound, array_to_string(c.reloptions, ', ') AS reloptions
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
  WHERE i.inhparent = '"Tweet"'::regclass
) b, pg_partitioned_table p
WHERE p.partrelid = '"Tweet"'::regclass;

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT leaf FROM mig.tweet_part LOOP
    EXECUTE format('ALTER TABLE "Tweet" DETACH PARTITION %I', r.leaf);
    EXECUTE format('DROP TABLE %I', r.leaf);
  END LOOP;
END
$$;
SQL
    [ "$(new_q "SELECT count(*) FROM mig.tweet_part")" != 0 ] || die "Tweet has no partitions; apply tweet-hash.sql or tweet-range.sql first"
}

# 選択中の方式から、行の所属先 (part_no) を返す SQL 式を作る。
write_part_expr() {
    local strat
    strat="$(new_q "SELECT partstrat FROM pg_partitioned_table WHERE partrelid = '\"Tweet\"'::regclass")"
    if [ "$strat" = h ]; then
        local m
        m="$(new_q "SELECT (regexp_match(bound, 'modulus (\d+)'))[1] FROM mig.tweet_part LIMIT 1")"
        # PostgreSQL のハッシュパーティションの振り分けと同じ計算 (HASH_PARTITION_SEED と hash_combine64 の定数)。
        # 計算が合っているかは、attach 時のパーティション制約の検証が全行に対して確認する。
        printf '((((hashint8extended(t."accountId"::bigint, 8816678312871386365)::numeric + 5305509591434766563) %% 18446744073709551616 + 18446744073709551616) %% 18446744073709551616) %% %s)::smallint' "$m" >"$WORK_DIR/part_expr"
    else
        local thresholds
        thresholds="$(new_q "SELECT string_agg((regexp_match(bound, 'FROM \(''?(-?\d+)''?\)'))[1], ',' ORDER BY part_no) FROM mig.tweet_part WHERE part_no >= 1")"
        printf 'width_bucket(t."id"::bigint, ARRAY[%s]::bigint[])::smallint' "$thresholds" >"$WORK_DIR/part_expr"
    fi
    echo "$strat" >"$WORK_DIR/tweet_strategy"
}

# ============================================================
# load
# ============================================================
# 各バッチを順に取り出して、1 本の COPY ストリームとして fd に流す。
pipe_batches() { # name file fmt fd
    local name="$1" file="$2" fmt="$3" fd="$4" n i first=1 out
    n="$(make_batches "$name" "$file")"
    for ((i = 0; i < n; i++)); do
        out="$WORK_DIR/batch.$name.$i"
        fetch_batch "$file" "$WORK_DIR/scope.$name.$i" "$fmt" "$out"
        if [ "$fmt" = binary ]; then
            # バイナリ COPY は先頭 19 バイトのヘッダと末尾 2 バイトのトレーラを持つ。つなぐときは中間のものを外す。
            if [ "$first" = 1 ]; then head -c -2 "$out" >&"$fd"; else tail -c +20 "$out" | head -c -2 >&"$fd"; fi
        else
            cat "$out" >&"$fd"
        fi
        first=0
        rm -f "$out"
    done
    [ "$fmt" = binary ] && printf '\377\377' >&"$fd"
    return 0
}

run_step() {
    local file="$1" name target cols fmt router t0=$SECONDS rows
    name="$(basename "$file" .sql)"
    step_enabled "$name" || return 0
    if [ "$FORCE" != 1 ] && step_done "$name"; then
        log "$name: already done"
        return 0
    fi
    target="$(hdr "$file" target)"
    cols="$(hdr "$file" columns)"
    fmt="$(hdr "$file" format || true)"
    [ -n "$fmt" ] || fmt=binary
    router="$(hdr "$file" router || true)"
    log "$name: start (-> $target)"
    if [ "$router" = tweet ]; then
        run_tweet_step "$name" "$file"
        return
    fi
    local fifo="$WORK_DIR/fifo.$name" fd cpid copy_opts="FORMAT $fmt, FREEZE"
    rm -f "$fifo"
    mkfifo "$fifo"
    new_psql -1 -c "TRUNCATE $target RESTART IDENTITY" -c "COPY $target ($cols) FROM STDIN ($copy_opts)" \
        <"$fifo" >"$WORK_DIR/log.$name" 2>&1 &
    cpid=$!
    exec {fd}>"$fifo"
    local rc=0
    pipe_batches "$name" "$file" "$fmt" "$fd" || rc=$?
    exec {fd}>&-
    wait "$cpid" || rc=$?
    rm -f "$fifo"
    [ "$rc" = 0 ] || die "$name failed: $(tail -n 5 "$WORK_DIR/log.$name")"
    rows="$(sed -n 's/^COPY //p' "$WORK_DIR/log.$name" | tail -n1)"
    record_step "$name" "${rows:-0}" $((SECONDS - t0))
    log "$name: done ${rows:-0} rows in $((SECONDS - t0))s"
}

run_tweet_step() {
    local name="$1" file="$2" t0=$SECONDS cols dir="$WORK_DIR/tweetfifos" in="$WORK_DIR/fifo.$name.in"
    cols="$(hdr "$file" columns)"
    write_part_expr
    rm -rf "$dir" "$in"
    mkdir -p "$dir"
    mkfifo "$in"
    local parts p leaf opts cpids=() rc=0
    parts="$(new_q "SELECT part_no FROM mig.tweet_part ORDER BY part_no" | tr '\n' ' ')"
    for p in $parts; do
        mkfifo "$dir/p$p"
        leaf="$(new_q "SELECT leaf FROM mig.tweet_part WHERE part_no = $p")"
        opts="$(new_q "SELECT COALESCE('WITH (' || reloptions || ')', '') FROM mig.tweet_part WHERE part_no = $p")"
        new_psql -1 -c "DROP TABLE IF EXISTS \"$leaf\"" \
            -c "CREATE TABLE \"$leaf\" (LIKE \"Tweet\" INCLUDING DEFAULTS) $opts" \
            -c "COPY \"$leaf\" ($cols) FROM STDIN (FORMAT text, FREEZE)" \
            <"$dir/p$p" >"$WORK_DIR/log.$name.p$p" 2>&1 &
        cpids+=($!)
    done
    # shellcheck disable=SC2086
    python3 -I "$HERE/tools/tweet-route.py" "$dir" $parts <"$in" 2>"$WORK_DIR/log.$name.router" &
    local router_pid=$! fd
    exec {fd}>"$in"
    pipe_batches "$name" "$file" text "$fd" || rc=$?
    exec {fd}>&-
    wait "$router_pid" || rc=$?
    local pid
    for pid in "${cpids[@]}"; do wait "$pid" || rc=$?; done
    [ "$rc" = 0 ] || die "$name failed: router: $(tail -n 3 "$WORK_DIR/log.$name.router"); $(cat "$WORK_DIR"/log.$name.p* | grep -i error | head -n 3)"
    local rows=0 n
    for p in $parts; do
        n="$(sed -n 's/^COPY //p' "$WORK_DIR/log.$name.p$p" | tail -n1)"
        rows=$((rows + ${n:-0}))
    done
    record_step "$name" "$rows" $((SECONDS - t0))
    log "$name: loaded $rows rows into $(echo $parts | wc -w) leaf tables in $((SECONDS - t0))s"
    rm -rf "$dir" "$in"
}

# 子パーティションを Tweet に attach する。範囲方式は、先に CHECK を付けて検証走査を省く。
attach_one() {
    local part="$1" leaf bound chk
    leaf="$(new_q "SELECT leaf FROM mig.tweet_part WHERE part_no = $part")"
    [ "$(new_q "SELECT attached FROM mig.tweet_part WHERE part_no = $part")" = t ] && return 0
    bound="$(new_q "SELECT bound FROM mig.tweet_part WHERE part_no = $part")"
    chk="$(new_q "SELECT CASE WHEN bound ~ 'FROM \(' THEN format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (%s)', leaf, leaf || '_range_check',
            concat_ws(' AND ',
              CASE WHEN bound !~ 'FROM \(MINVALUE\)' THEN format('\"id\" >= %s', (regexp_match(bound, 'FROM \(''?(-?\d+)''?\)'))[1]) END,
              CASE WHEN bound !~ 'TO \(MAXVALUE\)' THEN format('\"id\" < %s', (regexp_match(bound, 'TO \(''?(-?\d+)''?\)'))[1]) END)) END
            FROM mig.tweet_part WHERE part_no = $part")"
    [ -z "$chk" ] || new_psql -q -c "$chk" >/dev/null
    new_psql -q -c "ALTER TABLE \"Tweet\" ATTACH PARTITION \"$leaf\" $bound" >/dev/null
    [ -z "$chk" ] || new_psql -q -c "ALTER TABLE \"$leaf\" DROP CONSTRAINT \"${leaf}_range_check\"" >/dev/null
    new_psql -q -c "UPDATE mig.tweet_part SET attached = true WHERE part_no = $part" >/dev/null
}

attach_tweet_partitions() {
    step_enabled tweet_attach || return 0
    if [ "$FORCE" != 1 ] && step_done tweet_attach; then return 0; fi
    local t0=$SECONDS p running=0
    for p in $(new_q "SELECT part_no FROM mig.tweet_part ORDER BY part_no"); do
        attach_one "$p" &
        running=$((running + 1))
        if [ "$running" -ge "$JOBS" ]; then wait -n || die "attach failed"; running=$((running - 1)); fi
    done
    while [ "$running" -gt 0 ]; do wait -n || die "attach failed"; running=$((running - 1)); done
    [ "$(new_q "SELECT count(*) FROM mig.tweet_part WHERE NOT attached")" = 0 ] || die "some Tweet partitions are not attached"
    record_step tweet_attach 0 $((SECONDS - t0))
    log "tweet_attach: done in $((SECONDS - t0))s"
}

run_finalize() {
    local file="$1" name t0=$SECONDS
    name="fin_$(basename "$file" .sql)"
    step_enabled "$name" || return 0
    if [ "$FORCE" != 1 ] && step_done "$name"; then
        log "$name: already done"
        return 0
    fi
    log "$name: start"
    {
        printf "\\\\set work_mem '%s'\n" "${FINALIZE_WORK_MEM:-256MB}"
        cat "$file"
    } | new_psql -q -1 >"$WORK_DIR/log.$name" 2>&1 || die "$name failed: $(tail -n 5 "$WORK_DIR/log.$name")"
    record_step "$name" 0 $((SECONDS - t0))
    log "$name: done in $((SECONDS - t0))s"
}

load() {
    start_snapshot
    start_guard
    step_done prepare || die "run prepare first"
    [ -s "$WORK_DIR/lmap.json" ] || new_q "SELECT jsonb_object_agg(old_id, new_id)::text FROM mig.label_map" >"$WORK_DIR/lmap.json"
    write_part_expr
    # 大きい step (label_row、Tweet) を先に始める
    local files=() f
    for f in "$HERE"/transform/1[0-9]_*.sql "$HERE"/transform/0[1-9]_*.sql "$HERE"/transform/[2-9][0-9]_*.sql; do
        [ -e "$f" ] && files+=("$f")
    done
    local ordered=() big
    for big in 10_label_row 15_Tweet; do
        for f in "${files[@]}"; do [ "$(basename "$f" .sql)" = "$big" ] && ordered+=("$f"); done
    done
    for f in "${files[@]}"; do
        case "$(basename "$f" .sql)" in 10_label_row | 15_Tweet) ;; *) ordered+=("$f") ;; esac
    done
    local running=0
    for f in "${ordered[@]}"; do
        run_step "$f" &
        running=$((running + 1))
        if [ "$running" -ge "$JOBS" ]; then wait -n || die "a load step failed"; running=$((running - 1)); fi
    done
    while [ "$running" -gt 0 ]; do wait -n || die "a load step failed"; running=$((running - 1)); done
    attach_tweet_partitions
    for f in "$HERE"/finalize/*.sql; do run_finalize "$f"; done
}

# ============================================================
# restore: インデックス、制約、トリガー、FK を戻して統計を取る
# ============================================================
restore_table_indexes() {
    local table="$1" def name kind row rows
    # docker exec -i が標準入力を読み捨てるため、先に配列へ読み込んでから回す。
    mapfile -t rows < <(new_psql -At -F $'\t' -c "SELECT name, kind FROM mig.index_def WHERE table_name = '$table' AND NOT restored ORDER BY ord, name" </dev/null)
    for row in "${rows[@]}"; do
        IFS=$'\t' read -r name kind <<<"$row"
        def="$(new_q "SELECT def FROM mig.index_def WHERE table_name = '$table' AND name = '$name'")"
        log "restore: $table $name"
        if [ "$kind" = constraint ]; then
            new_psql -q -c "$def" >/dev/null
        else
            new_psql -q -c "SET maintenance_work_mem = '${INDEX_WORK_MEM:-1GB}'" -c "$def" >/dev/null
        fi
        new_psql -q -c "UPDATE mig.index_def SET restored = true WHERE table_name = '$table' AND name = '$name'" >/dev/null
    done
}

restore() {
    step_done tweet_attach || [ -n "$ONLY" ] || die "run load first"
    step_enabled restore || return 0
    if [ "$FORCE" != 1 ] && step_done restore; then log "restore: already done"; return 0; fi
    local t0=$SECONDS running=0 t
    for t in $(new_q "SELECT DISTINCT table_name FROM mig.index_def WHERE NOT restored"); do
        restore_table_indexes "$t" &
        running=$((running + 1))
        if [ "$running" -ge "${INDEX_JOBS:-2}" ]; then wait -n || die "index restore failed"; running=$((running - 1)); fi
    done
    while [ "$running" -gt 0 ]; do wait -n || die "index restore failed"; running=$((running - 1)); done
    for t in $TRIGGER_TABLES; do
        new_psql -q -c "ALTER TABLE \"$t\" ENABLE TRIGGER USER" >/dev/null
    done
    # FK を張り直す。張るときに全行が検証される。
    local def name tbl row fk_rows
    mapfile -t fk_rows < <(new_psql -At -F $'\t' -c "SELECT table_name, name FROM mig.fk_def WHERE NOT restored ORDER BY table_name, name" </dev/null)
    for row in "${fk_rows[@]}"; do
        IFS=$'\t' read -r tbl name <<<"$row"
        def="$(new_q "SELECT def FROM mig.fk_def WHERE table_name = '$tbl' AND name = '$name'")"
        log "restore: FK $tbl $name"
        new_psql -q -c "$def" >/dev/null || die "FK $name on $tbl does not validate"
        new_psql -q -c "UPDATE mig.fk_def SET restored = true WHERE table_name = '$tbl' AND name = '$name'" >/dev/null
    done
    # COPY FREEZE していない表 (INSERT SELECT で作った表) を凍結し、全表の統計を取る。bulk 中は autovacuum が止まっている。
    log "restore: VACUUM (FREEZE, ANALYZE)"
    new_psql -q -c "VACUUM (FREEZE, ANALYZE)" >/dev/null
    record_step restore 0 $((SECONDS - t0))
    log "restore: done in $((SECONDS - t0))s"
}

cleanup() {
    new_psql -q -c "DROP SCHEMA IF EXISTS stg CASCADE" -c "DROP SCHEMA IF EXISTS mig CASCADE" >/dev/null
    log "cleanup: dropped schemas stg and mig"
}

case "$PHASE" in
    prepare) prepare ;;
    load) load ;;
    restore) restore ;;
    cleanup) cleanup ;;
    all) prepare; load; restore ;;
    *) die "unknown phase: $PHASE" ;;
esac
