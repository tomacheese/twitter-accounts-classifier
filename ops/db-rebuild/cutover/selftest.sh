#!/bin/bash
# cutover スクリプトの自己テスト。scratch のコンテナだけを使い、本番には触れない (名前はすべて tac-t11st 始まり)。
# 小さな架空の旧 DB (旧スキーマ + testdata/seed-old.sql) と、旧コードのつもりのダミーのサービス群を作り、
#   1. 旧 DB の読み取り専用の凍結が失われた → 移行が進まない → ロールバック
#   2. 時間の目安を超えても止まらない通しの切り替え (検証ゲートの FAIL では止まる) → postcheck → ロールバック
#   3. 通しの切り替え → 24 時間後の blocker 起動 → ロールバック拒否 → watchtower の再開手順
# を実行して、結果を検査する。
#
# 使い方: ops/db-rebuild/cutover/selftest.sh
#   SELFTEST_OPS_DIR   ops/db-rebuild の場所 (既定は、このスクリプトの親)。load.sh などの移行ツールが揃っている必要がある
#   SELFTEST_REPO_ROOT prisma/migrations と scripts を持つリポジトリのルート
#   SELFTEST_WORKDIR   作業ディレクトリ (既定 /tmp/tac-cutover-selftest)
#   SEED_ACCOUNTS      旧 DB のアカウント数 (既定 300)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS="${SELFTEST_OPS_DIR:-$(dirname "$HERE")}"
REPO="${SELFTEST_REPO_ROOT:-$(cd "$OPS/../.." && pwd)}"
W="${SELFTEST_WORKDIR:-/tmp/tac-cutover-selftest}"
P=tac-t11st
OLD_DB=twitter_t11st_old
NEWC=tac-t11st-new-postgres

[ -x "$OPS/load.sh" ] || {
    echo "ERROR: migration tooling (load.sh) not found in $OPS; set SELFTEST_OPS_DIR" >&2
    exit 1
}
CUT="$OPS/cutover"

for v in NEW_DB_PROJECT NEW_DB_CONTAINER_NAME; do
    grep -q "$v" "$OPS/compose.new-db.yaml" || {
        echo "ERROR: $OPS/compose.new-db.yaml does not accept $v; the selftest would act on the real new DB container name. Use the tooling that supports the override" >&2
        exit 1
    }
done
if [ -n "$(docker ps -aq --filter 'name=^tac-new-postgres$')" ] || [ -n "$(docker ps -aq --filter 'label=com.docker.compose.project=tac-new-db')" ]; then
    echo "ERROR: a tac-new-postgres container or a tac-new-db compose project exists on this host; refusing to run the selftest here" >&2
    exit 1
fi

say() { printf '\n##### %s\n' "$*"; }
fail() {
    echo "SELFTEST FAIL: $*" >&2
    exit 1
}
expect_ok() { "$@" || fail "expected success: $*"; }
expect_fail() {
    if "$@"; then fail "expected failure: $*"; fi
    return 0
}
# cutover.env に 1 行足した設定で実行する (cutover.env の値は環境変数より優先されるため)
env_override() {
    local kv="$1"
    shift
    { cat "$W/cutover.env"; echo "$kv"; } >"$W/cutover.override.env"
    CUTOVER_ENV="$W/cutover.override.env" "$@"
}
same() { [ "$2" = "$3" ] || fail "$1: expected '$2', got '$3'"; echo "ok: $1 = $3"; }

compose() { docker compose -p "$P" -f "$W/prod/compose.yaml" "$@"; }
old_rw_sql() { docker exec -i -e PGOPTIONS='-c default_transaction_read_only=off' "$P-postgres-1" psql -U crawler -d "$OLD_DB" -X -q -At -v ON_ERROR_STOP=1 "$@"; }
old_sql() { docker exec -i "$P-postgres-1" psql -U crawler -d "$OLD_DB" -X -q -At -v ON_ERROR_STOP=1 "$@"; }
svc_image() { docker inspect -f '{{.Config.Image}}' "$(compose ps -aq "$1")"; }
svc_image_id() { docker inspect -f '{{.Image}}' "$(compose ps -aq "$1")"; }
svc_state() {
    local c
    c="$(compose ps -aq "$1")"
    if [ -z "$c" ]; then echo false; else docker inspect -f '{{.State.Running}}' "$c"; fi
}

cleanup() {
    docker ps -aq --filter "name=^tac-t11st-" | xargs -r docker rm -f >/dev/null 2>&1 || true
    docker network ls -q --filter "name=^tac-t11st" | xargs -r docker network rm >/dev/null 2>&1 || true
    if [ -d "$W/newdb" ]; then
        docker run --rm --user root -v "$W/newdb":/n alpine sh -c 'rm -rf /n/* /n/.[!.]*' >/dev/null 2>&1 || true
    fi
}
discard_new_db() {
    DB_PROFILE=bulk NEW_DB_PROJECT=tac-t11st-newdb NEW_DB_CONTAINER_NAME=$NEWC docker compose -f "$OPS/compose.new-db.yaml" down >/dev/null 2>&1 || true
    docker rm -f "$NEWC" >/dev/null 2>&1 || true
    docker run --rm --user root -v "$W/newdb":/n alpine sh -c 'rm -rf /n/data/* /n/data/.[!.]* /n/wal/* /n/backup/*' >/dev/null 2>&1 || true
}
trap 'if [ "${KEEP:-0}" != 1 ]; then cleanup; fi' EXIT

say "setup"
cleanup
rm -rf "$W/img" "$W/prod" "$W/state"
mkdir -p "$W/img/scripts" "$W/prod" "$W/newdb/data" "$W/newdb/wal" "$W/newdb/backup"
cp -r "$REPO/scripts/db" "$W/img/scripts/db"

# storage-guard のつもりのダミー。relabeler が前提にする StorageCapacityState を書き続ける。
cat >"$W/img/sg.sh" <<'EOF'
#!/bin/sh
while true; do
    psql "${DATABASE_URL%%\?*}" -X -q -c "INSERT INTO \"StorageCapacityState\" (id, \"availableGib\", \"usedPercent\", \"measuredAt\", \"updatedAt\") VALUES ('singleton', 100, 10, now(), now()) ON CONFLICT (id) DO UPDATE SET \"measuredAt\" = now(), \"updatedAt\" = now()" || true
    sleep 3
done
EOF

# アプリのイメージのつもりのダミー。postgresql-client と bash と scripts/db を持ち、権限同期スクリプトを実行できる。
cat >"$W/img/Dockerfile.app" <<'EOF'
FROM postgres:17-alpine
ARG VARIANT=old
LABEL selftest.variant=$VARIANT
RUN apk add --no-cache bash
COPY scripts /app/scripts
COPY sg.sh /app/sg.sh
ENTRYPOINT ["sh", "-c", "exec sleep 1000000"]
EOF
# viewer のつもりのダミー。どのパスにも 200 を返す。
cat >"$W/img/Dockerfile.viewer" <<'EOF'
FROM node:26.13.0-alpine
ARG VARIANT=old
LABEL selftest.variant=$VARIANT
ENTRYPOINT ["node", "-e", "require('http').createServer((q,r)=>r.end('ok')).listen(3000,'0.0.0.0')"]
EOF
for v in old new; do
    for n in crawler analyzer blocker; do
        docker build -q -f "$W/img/Dockerfile.app" --build-arg "VARIANT=$v" -t "$P/$n:$v" "$W/img" >/dev/null
    done
    docker build -q -f "$W/img/Dockerfile.viewer" --build-arg "VARIANT=$v" -t "$P/viewer:$v" "$W/img" >/dev/null
done

cat >"$W/prod/compose.yaml" <<EOF
services:
  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: crawler
      POSTGRES_PASSWORD: crawler
      POSTGRES_DB: $OLD_DB
  crawler:
    image: $P/crawler:old
    restart: unless-stopped
    depends_on: [postgres]
    environment:
      DATABASE_URL: postgresql://crawler:crawler@postgres:5432/$OLD_DB
  relabeler:
    image: $P/crawler:old
    restart: unless-stopped
    depends_on: [postgres]
    environment:
      DATABASE_URL: postgresql://crawler:crawler@postgres:5432/$OLD_DB?connection_limit=5&pool_timeout=0
  storage-guard:
    image: $P/crawler:old
    restart: unless-stopped
    entrypoint: ["sh", "/app/sg.sh"]
    depends_on: [postgres]
    environment:
      DATABASE_URL: postgresql://crawler:crawler@postgres:5432/$OLD_DB?connection_limit=1&pool_timeout=0
  blocker:
    image: $P/blocker:old
    restart: unless-stopped
    depends_on: [postgres]
    environment:
      DATABASE_URL: postgresql://crawler:crawler@postgres:5432/$OLD_DB
  analyzer:
    image: $P/analyzer:old
    restart: unless-stopped
    depends_on: [postgres]
    environment:
      DATABASE_URL: postgresql://analyzer:apass@postgres:5432/$OLD_DB?connection_limit=1&pool_timeout=0
  viewer:
    image: $P/viewer:old
    restart: unless-stopped
    depends_on: [postgres]
    environment:
      DATABASE_URL: postgresql://viewer:vpass@postgres:5432/$OLD_DB
EOF

cat >"$W/cutover.env" <<EOF
COMPOSE_PROJECT=$P
PROD_COMPOSE_DIR=$W/prod
OLD_DB_CONTAINER=$P-postgres-1
OLD_DB_NAME=$OLD_DB
OLD_DB_USER=crawler
WATCHTOWER_CONTAINER=tac-t11st-watchtower
APP_NETWORK=${P}_default
NEW_CONTAINER=$NEWC
NEW_DB_PROJECT=tac-t11st-newdb
NEW_DB_PORT=55471
NEW_DB_MEM_LIMIT=6g
NEW_DB_PASSWORD=selftest-owner-pass
NEW_APP_DB_PASSWORD=selftest-app-pass
NEW_DB_DATA_HOST_PATH=$W/newdb/data
NEW_DB_WAL_ARCHIVE_HOST_PATH=$W/newdb/wal
NEW_DB_BACKUP_HOST_PATH=$W/newdb/backup
TWEET_VARIANT=hash
NEW_IMAGE_CRAWLER=$P/crawler:new
NEW_IMAGE_VIEWER=$P/viewer:new
NEW_IMAGE_BLOCKER=$P/blocker:new
NEW_IMAGE_ANALYZER=$P/analyzer:new
EST_PREPARE_SECS=60
EST_LOAD_SECS=120
EST_RESTORE_SECS=60
EST_VERIFY_SECS=120
EST_STEADY_SECS=120
STATE_DIR=$W/state
OTHERS_NAME_REGEX=^/tac-t11st-other
KEEP_UPDATED=true
ENUM_UPDATED=1
SETTLE_SECS=3
STOP_TIMEOUT=3
FIO_SIZE=64M
# 小さなデータでは計画が Seq Scan になるため、EXPLAIN のゲートだけ Seq Scan を避ける設定にする (本番では使わない)
EXPLAIN_SEQSCAN=off
NEED_DATA_GIB=2
NEED_ARCHIVE_GIB=1
NEED_BACKUP_GIB=2
EOF
chmod 600 "$W/cutover.env"
export CUTOVER_ENV="$W/cutover.env"

say "old stack: schema from the migrations, then the fictional seed"
compose up -d >/dev/null
for _ in $(seq 1 60); do old_sql -c 'SELECT 1' >/dev/null 2>&1 && break || sleep 1; done
sleep 3
# Prisma は migration ごとにトランザクションで適用し、1 文だけの migration (CREATE INDEX CONCURRENTLY) は包まずに適用する
for f in "$REPO"/prisma/migrations/*/migration.sql; do
    { echo 'BEGIN;'; cat "$f"; echo 'COMMIT;'; } | old_sql >/dev/null 2>&1 || old_sql <"$f" >/dev/null 2>&1 || fail "migration failed: $f"
done
# migration が入れる初期行 (集計表の行など) を消して、スキーマだけにする。本番の pg_dump --schema-only と同じ状態にする
old_sql -c "DO \$\$ BEGIN EXECUTE (SELECT 'TRUNCATE ' || string_agg(format('%I', tablename), ', ') || ' RESTART IDENTITY CASCADE' FROM pg_tables WHERE schemaname = 'public'); END \$\$" >/dev/null
old_sql -v "seed_accounts=${SEED_ACCOUNTS:-300}" <"$OPS/testdata/seed-old.sql" >/dev/null
same "old Account rows" "${SEED_ACCOUNTS:-300}" "$(old_sql -c 'SELECT count(*) FROM "Account"')"

docker run -d --name tac-t11st-watchtower --restart unless-stopped alpine sleep 1000000 >/dev/null
docker run -d --name tac-t11st-other --restart unless-stopped alpine sleep 1000000 >/dev/null
OTHER_ID_BEFORE="$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' tac-t11st-other)"

say "dry-runs change nothing"
expect_ok "$CUT/run-migration.sh" --init-only --dry-run
expect_ok "$CUT/preflight.sh" --dry-run --stop-watchtower --skip-fio
expect_fail env_override NEED_DATA_GIB=999999 "$CUT/preflight.sh" --dry-run --stop-watchtower --skip-fio
same "watchtower still running after a dry-run" true "$(docker inspect -f '{{.State.Running}}' tac-t11st-watchtower)"
# watchtower が動いている間は、dry-run でも freeze は進まない
expect_fail "$CUT/freeze.sh" --dry-run
same "old DB still writable after a dry-run freeze" off "$(old_sql -c 'SHOW default_transaction_read_only')"
same "blocker still running after a dry-run freeze" true "$(svc_state blocker)"
expect_fail "$CUT/rollback.sh" --dry-run --reason manual
[ ! -e "$W/state/steps/freeze" ] || fail "a dry-run wrote a step marker"

say "initialize the new DB (as the day before the window)"
expect_ok "$CUT/run-migration.sh" --init-only
same "new DB data_checksums" on "$(docker exec "$NEWC" psql -U tac_owner -d twitter_accounts_classifier -At -c 'SHOW data_checksums')"
same "new DB wal_level" minimal "$(docker exec "$NEWC" psql -U tac_owner -d twitter_accounts_classifier -At -c 'SHOW wal_level')"

say "preflight fails while watchtower is running, passes after --stop-watchtower"
expect_fail "$CUT/preflight.sh" --skip-fio
expect_ok "$CUT/preflight.sh" --stop-watchtower
same "watchtower stopped" false "$(docker inspect -f '{{.State.Running}}' tac-t11st-watchtower)"
same "watchtower restart policy" no "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' tac-t11st-watchtower)"
docker image inspect tac-rollback/crawler:pre-rebuild >/dev/null || fail "rollback tag missing"
[ -f "$W/state/pinned-compose/.pinned" ] || fail "the production compose was not pinned"
# 本番ホストの compose.yaml が切り替えの途中で変わっても、切り替えとロールバックは控えの定義で行う
sed -i 's/connection_limit=5/connection_limit=7/' "$W/prod/compose.yaml"
expect_ok "$CUT/freeze.sh" --dry-run
expect_ok "$CUT/run-migration.sh" --dry-run
expect_ok "$CUT/switch.sh" --dry-run
expect_ok "$CUT/rollback.sh" --dry-run --reason manual
same "blocker still running after the dry-runs" true "$(svc_state blocker)"

say "scenario 1: the read-only freeze is lost -> the migration refuses to continue -> rollback"
expect_ok "$CUT/freeze.sh" --yes
same "old DB read-only after freeze" on "$(old_sql -c 'SHOW default_transaction_read_only')"
same "blocker stopped" false "$(svc_state blocker)"
same "viewer stopped" false "$(svc_state viewer)"
old_rw_sql -c "ALTER DATABASE $OLD_DB RESET default_transaction_read_only" >/dev/null
expect_fail "$CUT/freeze.sh" --check-readonly
expect_fail "$CUT/run-migration.sh"
[ ! -f "$W/state/steps/verified" ] || fail "verified marker exists although the migration refused to run"
expect_fail "$CUT/switch.sh" --yes
expect_fail "$CUT/rollback.sh" --reason nonsense --yes
expect_ok "$CUT/rollback.sh" --reason abort-before-cutover --yes
same "old DB writable after rollback" off "$(old_sql -c 'SHOW default_transaction_read_only')"
old_sql -c 'CREATE TABLE zz_probe (i int); DROP TABLE zz_probe' >/dev/null || fail "old DB rejects writes after rollback"
for s in crawler relabeler analyzer viewer storage-guard; do same "$s running after rollback" true "$(svc_state "$s")"; done
same "blocker NOT restarted by rollback" false "$(svc_state blocker)"
same "watchtower still stopped after rollback" false "$(docker inspect -f '{{.State.Running}}' tac-t11st-watchtower)"

say "scenario 2: full cutover -> postcheck -> rollback within the hour"
expect_ok "$CUT/preflight.sh" --skip-fio
# 未解決の outbox があると、freeze は blocker を止めた後でも進まない
old_sql -c "SET session_replication_role = replica; INSERT INTO \"BlockOutboxEntry\" (id, \"blockAccountRunId\", \"blockerId\", \"blockedId\", \"labelDefinitionId\", confidence, status, \"createdAt\") SELECT 'zz_pending', 'x', (SELECT id FROM \"Account\" LIMIT 1), (SELECT id FROM \"Account\" OFFSET 1 LIMIT 1), (SELECT id FROM \"LabelDefinition\" LIMIT 1), 0.9, 'pending_remote', now()" >/dev/null || fail "could not insert the fictional outbox row"
expect_fail "$CUT/freeze.sh" --yes
same "blocker stopped even though freeze refused" false "$(svc_state blocker)"
same "viewer still running when freeze refused" true "$(svc_state viewer)"
old_sql -c "DELETE FROM \"BlockOutboxEntry\" WHERE id = 'zz_pending'" >/dev/null
rm -f "$W/state/window_start"
expect_ok "$CUT/freeze.sh" --yes
expect_ok "$CUT/freeze.sh" --yes
# 時間の目安を超えても止まらず、完了まで進む (警告だけ出る)
env_override WINDOW_MINUTES=1 "$CUT/run-migration.sh" >"$W/migration.log" 2>&1 || {
    tail -n 30 "$W/migration.log"
    fail "run-migration stopped although only the time reference was exceeded"
}
grep -q 'projected duration exceeds the reference' "$W/migration.log" || fail "no warning about the time reference"
step="$W/state/steps"
[ -f "$step/verified" ] || fail "verified marker missing"
# 検証ゲートの FAIL は切り替えを止める
docker exec "$NEWC" psql -U tac_owner -d twitter_accounts_classifier -At -c "INSERT INTO \"StorageCapacityState\" (id, \"availableGib\", \"usedPercent\", \"measuredAt\", \"updatedAt\") VALUES ('zz_tamper', 1, 1, now(), now())" >/dev/null
expect_fail "$CUT/run-migration.sh" --from verify
[ ! -f "$step/verified" ] || fail "verified marker exists after a failed gate"
expect_fail "$CUT/switch.sh" --yes
docker exec "$NEWC" psql -U tac_owner -d twitter_accounts_classifier -At -c "DELETE FROM \"StorageCapacityState\" WHERE id = 'zz_tamper'" >/dev/null
expect_ok "$CUT/run-migration.sh" --from verify
[ -f "$step/verified" ] || fail "verified marker missing after the gates passed again"
env_override WINDOW_MINUTES=1 "$CUT/switch.sh" --yes >"$W/switch.log" 2>&1 || {
    tail -n 30 "$W/switch.log"
    fail "switch stopped although only the time reference was exceeded"
}
grep -q 'projected duration exceeds the reference' "$W/switch.log" || fail "no warning about the time reference before the switch"
for s in crawler relabeler analyzer viewer storage-guard; do
    same "$s on the new image" "$P/$(case $s in relabeler | storage-guard) echo crawler ;; *) echo "$s" ;; esac):new" "$(svc_image "$s")"
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(compose ps -aq "$s")" | grep -q "^DATABASE_URL=.*@$NEWC:5432/twitter_accounts_classifier" || fail "$s DATABASE_URL does not point at the new DB"
done
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(compose ps -aq relabeler)" | grep -q 'connection_limit=5&pool_timeout=0' || fail "relabeler lost its connection_limit query"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(compose ps -aq viewer)" | grep -q '^DATABASE_URL=postgresql://viewer:vpass@' || fail "viewer lost its dedicated role"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(compose ps -aq crawler)" | grep -q '^DATABASE_URL=postgresql://crawler:selftest-app-pass@' || fail "crawler does not use the app role password"
same "blocker is stopped after the switch" false "$(svc_state blocker)"
same "new DB wal_level after the switch" replica "$(docker exec "$NEWC" psql -U tac_owner -d twitter_accounts_classifier -At -c 'SHOW wal_level')"
same "app role is not a superuser" f "$(docker exec "$NEWC" psql -U tac_owner -d twitter_accounts_classifier -At -c "SELECT rolsuper FROM pg_roles WHERE rolname = 'crawler'")"
same "mig schema dropped" 0 "$(docker exec "$NEWC" psql -U tac_owner -d twitter_accounts_classifier -At -c "SELECT count(*) FROM pg_namespace WHERE nspname IN ('mig', 'stg')")"
expect_ok "$CUT/postcheck.sh"
# アプリ用ロールが set_label_result で書いた変更が、postcheck の整合性の検査に現れる
acct="$(docker exec "$NEWC" psql -U tac_owner -d twitter_accounts_classifier -At -c 'SELECT "accountId" FROM "AccountLabelState" ORDER BY 1 LIMIT 1')"
docker exec "$NEWC" psql -U crawler -d twitter_accounts_classifier -At -c "SELECT set_label_result(ARRAY[$acct]::bigint[], ARRAY[1]::smallint[], ARRAY[(SELECT rev FROM \"AccountLabelState\" WHERE \"accountId\" = $acct)], ARRAY[1]::smallint[], ARRAY[1]::smallint[], ARRAY[0.9]::float8[], ARRAY['selftest'], ARRAY['rule'], now(), 1::smallint, 'selftest_run', NULL)" >/dev/null
expect_ok "$CUT/postcheck.sh"
# 孤児を入れると postcheck が検出する (標本の割合を 100% にして、小さな表でも当たるようにする)
docker exec "$NEWC" psql -U tac_owner -d twitter_accounts_classifier -At -c 'INSERT INTO "AccountLabelState" ("accountId", "evaluatedAt") VALUES (999, now())' >/dev/null
expect_fail env_override ORPHAN_SAMPLE_PCT=100 "$CUT/postcheck.sh"
docker exec "$NEWC" psql -U tac_owner -d twitter_accounts_classifier -At -c 'DELETE FROM "AccountLabelState" WHERE "accountId" = 999' >/dev/null
expect_fail "$CUT/switch.sh" blocker --confirm-observed-24h --yes
expect_ok "$CUT/rollback.sh" --reason errors-1h --yes
same "old DB writable after rollback 2" off "$(old_sql -c 'SHOW default_transaction_read_only')"
for s in crawler relabeler analyzer viewer storage-guard; do
    same "$s back on the old image" "$(docker image inspect -f '{{.Id}}' "$P/$(case $s in relabeler | storage-guard) echo crawler ;; *) echo "$s" ;; esac):old")" "$(svc_image_id "$s")"
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(compose ps -aq "$s")" | grep -q "@postgres:5432/$OLD_DB" || fail "$s is not back on the old DB"
done
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(compose ps -aq relabeler)" | grep -q 'connection_limit=5&pool_timeout=0' || fail "rollback did not use the pinned compose (relabeler query changed)"
same "blocker NOT restarted by rollback 2" false "$(svc_state blocker)"
discard_new_db

say "scenario 3: full cutover -> blocker after 24h -> rollback refused -> watchtower re-enable"
expect_ok "$CUT/run-migration.sh" --init-only
expect_ok "$CUT/preflight.sh" --skip-fio
expect_ok "$CUT/freeze.sh" --yes
expect_ok "$CUT/run-migration.sh"
expect_ok "$CUT/switch.sh" --yes
expect_fail "$CUT/switch.sh" blocker --confirm-observed-24h --yes
echo "$(($(date +%s) - 90000))" >"$W/state/switched_at"
expect_fail "$CUT/switch.sh" blocker --yes
expect_ok "$CUT/switch.sh" blocker --confirm-observed-24h --yes
same "blocker running" true "$(svc_state blocker)"
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(compose ps -aq blocker)" | grep -q "@$NEWC:5432/" || fail "blocker does not point at the new DB"
expect_fail "$CUT/rollback.sh" --reason errors-1h --yes
same "old DB still read-only after the refused rollback" on "$(old_sql -c 'SHOW default_transaction_read_only')"

# master のイメージのつもりで、compose が指す :old へ載せ替える (レジストリは使わない)
export REENABLE_PULL=0
expect_fail "$CUT/reenable-watchtower.sh" check
expect_fail "$CUT/reenable-watchtower.sh" enable --yes
same "watchtower still stopped" false "$(docker inspect -f '{{.State.Running}}' tac-t11st-watchtower)"
expect_ok "$CUT/reenable-watchtower.sh" adopt --yes
expect_ok "$CUT/reenable-watchtower.sh" check
for s in crawler relabeler analyzer viewer storage-guard blocker; do
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$(compose ps -aq "$s")" | grep -q "@$NEWC:5432/" || fail "$s lost the new DB URL after adopt"
done
WATCH_SECS=20 expect_ok "$CUT/reenable-watchtower.sh" enable --yes
same "watchtower running again" true "$(docker inspect -f '{{.State.Running}}' tac-t11st-watchtower)"
same "watchtower restart policy restored" unless-stopped "$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' tac-t11st-watchtower)"

same "other project's container untouched" "$OTHER_ID_BEFORE" "$(docker inspect -f '{{.Id}} {{.State.StartedAt}}' tac-t11st-other)"
say "SELFTEST PASSED"
