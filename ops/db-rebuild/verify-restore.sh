#!/bin/bash
# ベースバックアップを別の scratch コンテナへリストアし、起動できることと設定を検証する。
# 使い方: ops/db-rebuild/verify-restore.sh <ベースバックアップのホストパス>
#   KEEP_RESTORE=1        検証後もリストア先ディレクトリを残す
#   SKIP_PG_CHECKSUMS=1   停止後の pg_checksums --check を省略する
# リストア先はバックアップ先の親 (NEW_DB_RESTORE_PARENT で変更可) に作る。コピーのため、バックアップと同じだけの空きが要る。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${NEW_DB_IMAGE:-postgres:17-alpine}"
DB_USER="${NEW_DB_USER:-crawler}"
DB_NAME="${NEW_DB_NAME:-twitter_accounts_classifier}"
RESTORE_CONTAINER=tac-new-restore-verify

if [ $# -ne 1 ]; then
    echo "usage: $0 <base backup directory containing backup_manifest>" >&2
    exit 1
fi
# バックアップは postgres (uid 70) 所有の 0700 のため、ホストからは中身を見られない。存在確認もコンテナ経由で行う。
SRC="$(realpath -m "$1")"
if ! docker run --rm -v "$SRC":/src:ro --entrypoint test "$IMAGE" -f /src/backup_manifest; then
    echo "ERROR: $SRC does not contain backup_manifest" >&2
    exit 1
fi
# バックアップ先ディレクトリ自体は uid 70 所有でホストから作れないため、その親に作る。
RESTORE_PARENT="${NEW_DB_RESTORE_PARENT:-$(dirname "$(dirname "$SRC")")}"
DST="$(mktemp -d "$RESTORE_PARENT/postgres-new-restore.XXXXXX")"

cleanup() {
    docker rm -f "$RESTORE_CONTAINER" >/dev/null 2>&1 || true
    if [ "${KEEP_RESTORE:-0}" != "1" ]; then
        docker run --rm --user root -v "$DST":/dst --entrypoint sh "$IMAGE" -c 'rm -rf /dst/* /dst/.[!.]*' || true
        rmdir "$DST" 2>/dev/null || true
    else
        echo "kept restore directory: $DST"
    fi
}
trap cleanup EXIT

# バックアップ自体の整合性 (マニフェストのチェックサムと WAL)。
docker run --rm -v "$SRC":/src:ro --entrypoint pg_verifybackup "$IMAGE" /src

# 所有者 (uid 70) と権限を保ったままコピーする。
docker run --rm --user root -v "$SRC":/src:ro -v "$DST":/dst --entrypoint sh "$IMAGE" -c '
    cp -a /src/. /dst/ && chmod 700 /dst
'

# 本番のアーカイブ先を汚さないよう、アーカイブは無効にしてアーカイブ先もマウントしない。
docker run -d --name "$RESTORE_CONTAINER" --stop-signal SIGINT --shm-size 1g \
    -v "$DST":/var/lib/postgresql/data \
    -v "$DIR/conf/postgresql.conf":/etc/postgresql-new/postgresql.conf:ro \
    -v "$DIR/conf/profile-steady.conf":/etc/postgresql-new/profile.conf:ro \
    -e PGDATA=/var/lib/postgresql/data \
    "$IMAGE" postgres -c config_file=/etc/postgresql-new/postgresql.conf -c archive_mode=off >/dev/null

for _ in $(seq 1 60); do
    docker exec "$RESTORE_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1 && break
    sleep 2
done
docker exec "$RESTORE_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME"

q() {
    docker exec "$RESTORE_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -Atc "$1"
}
expect() {
    local label="$1" actual="$2" expected="$3"
    if [ "$actual" != "$expected" ]; then
        echo "ERROR: $label: expected '$expected', got '$actual'" >&2
        exit 1
    fi
    echo "ok: $label = $actual"
}

expect data_checksums "$(q 'SHOW data_checksums')" on
expect in_recovery "$(q 'SELECT pg_is_in_recovery()')" f
expect wal_level "$(q 'SHOW wal_level')" replica
expect locale "$(q "SELECT datlocprovider::text || ':' || datlocale FROM pg_database WHERE datname = current_database()")" "b:C.UTF-8"
expect extensions "$(q "SELECT string_agg(extname, ',' ORDER BY extname) FROM pg_extension WHERE extname IN ('pg_stat_statements','pg_trgm')")" "pg_stat_statements,pg_trgm"
q 'SELECT count(*) FROM pg_stat_statements' >/dev/null

docker stop -t 120 "$RESTORE_CONTAINER" >/dev/null
if [ "${SKIP_PG_CHECKSUMS:-0}" != "1" ]; then
    docker run --rm --user postgres -v "$DST":/var/lib/postgresql/data --entrypoint pg_checksums "$IMAGE" \
        --check -D /var/lib/postgresql/data
fi
echo "restore verification passed: $SRC"
