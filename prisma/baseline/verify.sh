#!/bin/bash
# baseline の検証。使い捨ての PostgreSQL 17 コンテナを自分で起動し、本番の DB には一切接続しない。
#
# 検証内容 (tweet-hash.sql 版と tweet-range.sql 版の両方):
# - baseline.sql、tweet-*.sql、functions.sql が空の DB に単一トランザクションで適用できる
# - カタログ検査 (verify-schema.sql)
# - set_label_result と監査トリガーの逐次テスト (verify-behavior.sql)
# - 古い評価が新しい評価を上書きしない並行書き込みのテスト
# - アプリ用ロールの直接 DML が拒否される
# - `prisma migrate diff` の差分が、ホワイトリスト (Prisma で表現できないインデックス) に収まる
#
# 前提: docker、psql、リポジトリルートで `pnpm install` 済みであること。
# 使い方: prisma/baseline/verify.sh
set -euo pipefail

cd "$(dirname "$0")"
BASELINE_DIR="$(pwd)"
ROOT="$(cd ../.. && pwd)"
PRISMA="$ROOT/node_modules/.bin/prisma"
IMAGE="${BASELINE_VERIFY_PG_IMAGE:-postgres:17-alpine}"
NAME="baseline-verify-pg-$$"
WORK="$(mktemp -d)"

if [ ! -x "$PRISMA" ]; then
    echo "ERROR: $PRISMA not found; run 'pnpm install' at the repository root" >&2
    exit 1
fi

cleanup() {
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# --- 使い捨てのサーバーを起動する (ホスト側のポートは空きを自動で割り当てる) ---
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=verify -p 127.0.0.1::5432 "$IMAGE" -c fsync=off >/dev/null
PORT="$(docker port "$NAME" 5432/tcp | head -n 1 | sed 's/.*://')"
ADMIN="postgresql://postgres:verify@127.0.0.1:$PORT"
# 公式イメージは初期化後に再起動するため、接続できる状態が続くまで待つ。
ready=0
for _ in $(seq 1 60); do
    if psql -X -q "$ADMIN/postgres" -c 'SELECT 1' >/dev/null 2>&1; then
        ready=$((ready + 1))
        [ "$ready" -ge 3 ] && break
    else
        ready=0
    fi
    sleep 1
done
[ "$ready" -ge 3 ] || fail "scratch postgres did not become ready"
echo "scratch postgres: $(psql -X -At "$ADMIN/postgres" -c 'SHOW server_version') on port $PORT"

# アプリ用ロール。所有者でもスーパーユーザーでもない。functions.sql が存在を見て権限を整える。
psql -X -q -v ON_ERROR_STOP=1 "$ADMIN/postgres" <<'SQL'
CREATE ROLE crawler LOGIN NOSUPERUSER PASSWORD 'crawler';
CREATE ROLE viewer LOGIN NOSUPERUSER PASSWORD 'viewer';
SQL

# --- Prisma の検査 ---
# .env の DATABASE_URL (開発機の接続先) を使わないよう、起動する prisma には使い捨てサーバーを明示する。
export DATABASE_URL="$ADMIN/postgres"
"$PRISMA" validate --schema "$ROOT/prisma/schema.prisma" >/dev/null
"$PRISMA" generate --schema "$ROOT/prisma/schema.prisma" >/dev/null
echo "prisma validate / generate: ok"

# RANGE 版では PK が id 単独になるため、Prisma の schema を同じように書き換えて diff に使う。
RANGE_SCHEMA="$WORK/schema.range.prisma"
python3 -I - "$ROOT/prisma/schema.prisma" "$RANGE_SCHEMA" <<'PY'
import re, sys
src = open(sys.argv[1], encoding='utf-8').read()
a = src.index('model Tweet {')
b = src.index('\n}\n', a)
body = src[a:b]
body = re.sub(r'^(\s+)id(\s+)BigInt\s*$', r'\1id\2BigInt @id', body, flags=re.M)
body = re.sub(r'^\s*@@id\(\[accountId, id\]\)\s*$\n', '', body, flags=re.M)
body = re.sub(r'^\s*@@index\(\[id\]\)[ \t]*$\n?', '', body, flags=re.M)
open(sys.argv[2], 'w', encoding='utf-8').write(src[:a] + body + src[b:])
PY
grep -q '@@id(\[accountId, id\])' "$RANGE_SCHEMA" && fail "range schema transform did not remove the composite id"

# diff の出力 (SQL 文だけ) がホワイトリストに収まることを確かめる。
# Prisma は部分インデックス、式インデックス、パーティションの子、トリガー、関数を見ない。
# 見える差分は、既定外の演算子クラス (gin_trgm_ops) のインデックスと、RANGE 版だけにある (accountId, id DESC) のインデックス。
check_prisma_diff() {
    local variant="$1" url="$2" schema="$3" out
    out="$("$PRISMA" migrate diff --from-url "$url" --to-schema-datamodel "$schema" --script 2>&1)" \
        || fail "prisma migrate diff failed: $out"
    local statements unexpected
    statements="$(printf '%s\n' "$out" | grep -v '^--' | grep -v '^[[:space:]]*$' || true)"
    local allowed='^DROP INDEX "AccountSummaryLatest_(normalizedDisplayName|searchDocument)_gin_idx";$'
    if [ "$variant" = "range" ]; then
        allowed="$allowed|^DROP INDEX \"Tweet_accountId_id_idx\";\$"
    fi
    unexpected="$(printf '%s\n' "$statements" | grep -Ev "$allowed" || true)"
    [ -z "$unexpected" ] || fail "prisma migrate diff ($variant) has differences outside the whitelist:
$unexpected"
    echo "prisma migrate diff ($variant): only whitelisted differences"
}

# --- 並行書き込みのテスト用ヘルパー ---
# psql を別プロセスで走らせ、1 本目がロックを持っている間に 2 本目を呼ぶ。
run_cas_race() {
    local url="$1" account="$2" label="$3"
    # 先行: rev = 0 の新規 (または既存の現在値) を読み、true を書いたあと、コミットまで少し待つ。
    local rev
    rev="$(psql -X -At "$url" -c "SELECT coalesce((SELECT rev FROM \"AccountLabelState\" WHERE \"accountId\" = $account), 0)")"
    cat >"$WORK/first.sql" <<SQL
BEGIN;
SELECT set_label_result(ARRAY[$account]::bigint[], ARRAY[$label]::smallint[], ARRAY[$rev], ARRAY[1]::smallint[],
    ARRAY[1]::smallint[], ARRAY[0.9]::float8[], ARRAY['newer'], ARRAY['rule'], now(), 1::smallint, 'newer_run', NULL);
SELECT pg_sleep(1.5);
COMMIT;
SQL
    # 後続: 同じ rev を前提にした古い評価 (false)。先行のコミットまでロック待ちし、rev の不一致で戻る。
    cat >"$WORK/second.sql" <<SQL
SELECT set_label_result(ARRAY[$account]::bigint[], ARRAY[$label]::smallint[], ARRAY[$rev], ARRAY[0]::smallint[],
    ARRAY[1]::smallint[], ARRAY[NULL]::float8[], ARRAY[NULL], ARRAY[NULL], now(), 1::smallint, 'older_run', NULL);
SQL
    psql -X -q -At -v ON_ERROR_STOP=1 "$url" -f "$WORK/first.sql" >"$WORK/first.out" 2>&1 &
    local first_pid=$!
    # 先行がロックを持ったまま待機に入るのを待ってから、後続を起動する。
    local waited=0
    until [ "$(psql -X -At "$url" -c "SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE '%pg_sleep(1.5)%' AND pid <> pg_backend_pid()")" = "1" ]; do
        waited=$((waited + 1))
        [ "$waited" -le 100 ] || fail "the first writer did not reach its wait"
        sleep 0.1
    done
    psql -X -q -At -v ON_ERROR_STOP=1 "$url" -f "$WORK/second.sql" >"$WORK/second.out" 2>&1
    wait "$first_pid" || fail "the first writer failed: $(cat "$WORK/first.out")"
    CAS_SECOND_RESULT="$(tr -d '[:space:]' <"$WORK/second.out")"
}

# Tweet の実行計画。ID 単独の検索が全件走査にならず、アカウント指定の取得が 1 パーティションに絞られることを確かめる。
check_tweet_plans() {
    local url="$1" plan
    psql -X -q -v ON_ERROR_STOP=1 "$url" -c "
        INSERT INTO \"Tweet\" (id, \"accountId\", \"createdAt\", \"retweetCount\", \"likeCount\", \"replyCount\", \"fullText\")
        SELECT 1700000000000000000::bigint + g::bigint * 1000003, 1000 + (g % 5000), now() - (g || ' seconds')::interval, 0, 0, 0, 'dummy ' || g
        FROM generate_series(1, 300000) g;
        ANALYZE \"Tweet\";"
    plan="$(psql -X -At "$url" -c "EXPLAIN (COSTS OFF) SELECT id FROM \"Tweet\" WHERE id IN (1700000000010000030, 1700000000020000060)")"
    printf '%s' "$plan" | grep -q 'Seq Scan' && fail "ID-only lookup seq-scans Tweet: $plan"
    [ "$(printf '%s\n' "$plan" | grep -c 'Index.*Scan using "Tweet_h[0-9]*_id_idx"')" = "32" ] \
        || fail "ID-only lookup does not probe 32 per-partition id indexes: $plan"
    plan="$(psql -X -At "$url" -c "EXPLAIN (COSTS OFF) SELECT id FROM \"Tweet\" WHERE \"accountId\" = 1234 ORDER BY \"createdAt\" DESC LIMIT 20")"
    [ "$(printf '%s\n' "$plan" | grep -c 'Scan.*on "Tweet_h')" = "1" ] \
        || fail "recent-tweets lookup does not prune to one partition: $plan"
    printf '%s' "$plan" | grep -q 'Seq Scan' && fail "recent-tweets lookup seq-scans Tweet: $plan"
    psql -X -q -v ON_ERROR_STOP=1 "$url" -c 'TRUNCATE "Tweet"'
    echo "Tweet plans: ID-only lookup probes 32 id indexes, per-account lookup prunes to one partition"
}

run_variant() {
    local variant="$1" db="bv_$1" url
    url="$ADMIN/$db"
    echo "=== variant: $variant ==="
    psql -X -q "$ADMIN/postgres" -c "CREATE DATABASE $db"

    # アプリ用ロールが、全権限を持つ状態から始める (権限の同期スクリプトが後から付与する状況の再現)。
    # functions.sql の REVOKE が効いていることを確かめるため。
    psql -X -q -v ON_ERROR_STOP=1 "$url" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO crawler, viewer"
    psql -X -q -v ON_ERROR_STOP=1 -1 "$url" \
        -f "$BASELINE_DIR/baseline.sql" -f "$BASELINE_DIR/tweet-$variant.sql" -f "$BASELINE_DIR/functions.sql" \
        >/dev/null
    echo "baseline applied in a single transaction"

    psql -X -q -v ON_ERROR_STOP=1 -v "tweet_variant=$variant" "$url" -f "$BASELINE_DIR/verify-schema.sql" | grep passed
    psql -X -q -v ON_ERROR_STOP=1 "$url" -f "$BASELINE_DIR/verify-behavior.sql" | grep passed

    # 古い評価 (false) が、新しい評価 (true) のコミット後に上書きしない。状態行のあるアカウント。
    psql -X -q -v ON_ERROR_STOP=1 "$url" -c "
        SELECT set_label_result(ARRAY[2001]::bigint[], ARRAY[1]::smallint[], ARRAY[0], ARRAY[0]::smallint[],
            ARRAY[1]::smallint[], ARRAY[NULL]::float8[], ARRAY[NULL], ARRAY[NULL], now(), 1::smallint, 'setup', NULL)" >/dev/null
    run_cas_race "$url" 2001 1
    [ "$CAS_SECOND_RESULT" = "{2001}" ] || fail "($variant) stale writer was not reported as a miss: '$CAS_SECOND_RESULT'"
    [ "$(psql -X -At "$url" -c "SELECT count(*) FROM \"AccountActiveLabel\" WHERE \"accountId\" = 2001 AND \"sourceId\" = 'newer_run'")" = "1" ] \
        || fail "($variant) the newer evaluation was overwritten"
    [ "$(psql -X -At "$url" -c "SELECT rev FROM \"AccountLabelState\" WHERE \"accountId\" = 2001")" = "2" ] \
        || fail "($variant) rev after the race is not 2"
    echo "concurrent writers (existing state row): stale writer is reported, newer evaluation kept"

    # 新規アカウント (状態行なし) の同時初回書き込み。
    run_cas_race "$url" 2002 1
    [ "$CAS_SECOND_RESULT" = "{2002}" ] || fail "($variant) stale first writer was not reported as a miss: '$CAS_SECOND_RESULT'"
    [ "$(psql -X -At "$url" -c "SELECT count(*) FROM \"AccountActiveLabel\" WHERE \"accountId\" = 2002 AND \"sourceId\" = 'newer_run'")" = "1" ] \
        || fail "($variant) the first writer of a new account was overwritten"
    [ "$(psql -X -At "$url" -c "SELECT rev FROM \"AccountLabelState\" WHERE \"accountId\" = 2002")" = "1" ] \
        || fail "($variant) rev of the new account is not 1"
    echo "concurrent writers (no state row yet): stale first writer is reported, newer evaluation kept"

    # 1 アカウントへの多重書き込み。CAS に成功した回数と最終 rev が一致し、監査の増減が行の有無と一致する。
    psql -X -q -v ON_ERROR_STOP=1 "$url" -c "CREATE TABLE conc_log (worker int, ok boolean)"
    local workers=6 iterations=25 w
    for w in $(seq 1 "$workers"); do
        : >"$WORK/worker_$w.sql"
        for _ in $(seq 1 "$iterations"); do
            local label=$((RANDOM % 3 + 1)) outcome=$((RANDOM % 3 - 1))
            cat >>"$WORK/worker_$w.sql" <<SQL
SELECT coalesce((SELECT rev FROM "AccountLabelState" WHERE "accountId" = 3001), 0) AS r \gset
SELECT (set_label_result(ARRAY[3001]::bigint[], ARRAY[$label]::smallint[], ARRAY[:r]::integer[], ARRAY[$outcome]::smallint[],
    ARRAY[1]::smallint[], ARRAY[0.5]::float8[], ARRAY['stress'], ARRAY['rule'], now(), 1::smallint, 'w$w', NULL)
    = ARRAY[]::bigint[]) AS ok \gset
INSERT INTO conc_log (worker, ok) VALUES ($w, :'ok');
SQL
        done
    done
    local pids=()
    for w in $(seq 1 "$workers"); do
        psql -X -q -v ON_ERROR_STOP=1 "$url" -f "$WORK/worker_$w.sql" >"$WORK/worker_$w.out" 2>&1 &
        pids+=("$!")
    done
    for pid in "${pids[@]}"; do
        wait "$pid" || fail "($variant) a stress worker failed: $(cat "$WORK"/worker_*.out)"
    done
    psql -X -q -v ON_ERROR_STOP=1 "$url" -f /dev/stdin >/dev/null <<'SQL' || fail "($variant) stress invariants violated"
DO $$
DECLARE
    v_applied bigint;
    v_rev integer;
    v_bad bigint;
BEGIN
    SELECT count(*) FILTER (WHERE ok) INTO v_applied FROM conc_log;
    SELECT rev INTO v_rev FROM "AccountLabelState" WHERE "accountId" = 3001;
    IF v_applied <> v_rev THEN
        RAISE EXCEPTION 'applied writes (%) differ from rev (%)', v_applied, v_rev;
    END IF;
    IF (SELECT count(*) FROM conc_log) <> 150 THEN
        RAISE EXCEPTION 'some stress iterations did not run';
    END IF;
    -- ラベルごとに、added - (removed + unevaluable) が、true の行の有無 (1 または 0) と一致する。
    SELECT count(*) INTO v_bad
    FROM generate_series(1, 3) AS l
    WHERE (SELECT count(*) FILTER (WHERE "changeType" = 'added') - count(*) FILTER (WHERE "changeType" <> 'added')
                  FROM "AccountLabelChange" WHERE "accountId" = 3001 AND "labelDefinitionId" = l)
        <> (SELECT count(*) FROM "AccountActiveLabel" WHERE "accountId" = 3001 AND "labelDefinitionId" = l);
    IF v_bad > 0 THEN
        RAISE EXCEPTION 'audit rows do not match active label rows for % labels', v_bad;
    END IF;
END
$$;
SQL
    psql -X -q -v ON_ERROR_STOP=1 "$url" -c "DROP TABLE conc_log"
    echo "stress ($workers workers x $iterations writes): applied count equals rev, audit matches rows"

    # アプリ用ロールからの直接 DML は、権限で拒否される。set_label_result だけが通る。
    psql -X -q -v ON_ERROR_STOP=1 "$url" >/dev/null <<'SQL'
GRANT USAGE ON SCHEMA public TO crawler, viewer;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO crawler, viewer;
SQL
    local app_url="$ADMIN/$db" stmt out
    app_url="postgresql://crawler:crawler@127.0.0.1:$PORT/$db"
    local denied=(
        "INSERT INTO \"AccountActiveLabel\" (\"accountId\", \"labeledAt\", \"confidence\", \"labelDefinitionId\", \"ruleVersionNo\", \"method\", \"reason\") VALUES (9001, now(), 0.5, 1, 1, 'rule', 'direct')"
        "UPDATE \"AccountActiveLabel\" SET \"confidence\" = 0.1"
        "DELETE FROM \"AccountActiveLabel\""
        "INSERT INTO \"AccountLabelState\" (\"accountId\", \"evaluatedAt\") VALUES (9001, now())"
        "UPDATE \"AccountLabelState\" SET \"rev\" = 0"
        "DELETE FROM \"AccountLabelState\""
        "TRUNCATE \"AccountActiveLabel\""
        "TRUNCATE \"AccountLabelState\""
        "CREATE TRIGGER forged_trigger AFTER INSERT ON \"AccountActiveLabel\" FOR EACH ROW EXECUTE FUNCTION account_active_label_change_audit()"
    )
    for stmt in "${denied[@]}"; do
        if out="$(psql -X -q -v ON_ERROR_STOP=1 "$app_url" -c "$stmt" 2>&1)"; then
            fail "($variant) app role was allowed: $stmt"
        fi
        printf '%s' "$out" | grep -q 'permission denied' || fail "($variant) unexpected error for '$stmt': $out"
    done
    psql -X -q -v ON_ERROR_STOP=1 "$app_url" -c "
        SELECT set_label_result(ARRAY[9002]::bigint[], ARRAY[1]::smallint[], ARRAY[0], ARRAY[1]::smallint[],
            ARRAY[1]::smallint[], ARRAY[0.5]::float8[], ARRAY['via function'], ARRAY['rule'], now(), 1::smallint, 'app_run', NULL)" >/dev/null \
        || fail "($variant) app role could not call set_label_result"
    [ "$(psql -X -At "$url" -c "SELECT count(*) FROM \"AccountLabelChange\" WHERE \"accountId\" = 9002 AND \"changeType\" = 'added'")" = "1" ] \
        || fail "($variant) a write by the app role was not audited"
    # 書き込み側ではないロール (viewer) は、関数も呼べない。
    if out="$(psql -X -q -v ON_ERROR_STOP=1 "postgresql://viewer:viewer@127.0.0.1:$PORT/$db" -c "
        SELECT set_label_result(ARRAY[9003]::bigint[], ARRAY[1]::smallint[], ARRAY[0], ARRAY[1]::smallint[],
            ARRAY[1]::smallint[], ARRAY[0.5]::float8[], ARRAY['x'], ARRAY['rule'], now(), 1::smallint, 'v', NULL)" 2>&1)"; then
        fail "($variant) a read-only role could call set_label_result"
    fi
    printf '%s' "$out" | grep -q 'permission denied for function' || fail "($variant) unexpected error for viewer: $out"
    echo "app role: direct DML, TRUNCATE and CREATE TRIGGER denied (9 statements), set_label_result allowed, read-only role denied"

    if [ "$variant" = "hash" ]; then
        check_tweet_plans "$url"
    fi

    if [ "$variant" = "range" ]; then
        check_prisma_diff "$variant" "$url" "$RANGE_SCHEMA"
        # 負の対照: RANGE 版を HASH 版の schema と比べると、Tweet の PK の差分が検出される。
        out="$("$PRISMA" migrate diff --from-url "$url" --to-schema-datamodel "$ROOT/prisma/schema.prisma" --script 2>&1)"
        printf '%s' "$out" | grep -q '"Tweet"' || fail "negative control: a Tweet primary key difference was not detected"
        echo "prisma migrate diff (negative control): a different Tweet primary key is detected"
    else
        check_prisma_diff "$variant" "$url" "$ROOT/prisma/schema.prisma"
    fi
}

run_variant hash
run_variant range
echo "ALL BASELINE CHECKS PASSED"
