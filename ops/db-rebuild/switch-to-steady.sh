#!/bin/bash
# 一括投入プロファイル (bulk) から定常運用プロファイル (steady) へ切り替える。
#   1. CHECKPOINT して再起動 (wal_level=replica、archive_mode=on)
#   2. ANALYZE (bulk 中は autovacuum が止まっているため統計がない)
#   3. WAL アーカイブの動作確認
#   4. 最初の pg_basebackup と pg_verifybackup
# 検証ゲートを通過した後に実行する。環境変数は compose.new-db.yaml と共通。
# SKIP_ANALYZE=1 で ANALYZE を省略できる。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTAINER="${NEW_DB_CONTAINER_NAME:-tac-new-postgres}"
DB_USER="${NEW_DB_USER:-tac_owner}"
DB_NAME="${NEW_DB_NAME:-twitter_accounts_classifier}"

psql_c() {
    docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -Atc "$1"
}

current="$(psql_c 'SHOW wal_level')"
if [ "$current" != "minimal" ]; then
    echo "ERROR: wal_level is '$current', expected 'minimal' (already switched?)" >&2
    exit 1
fi

psql_c 'CHECKPOINT' >/dev/null
DB_PROFILE=steady docker compose -f "$DIR/compose.new-db.yaml" up -d --force-recreate --wait

wal_level="$(psql_c 'SHOW wal_level')"
archive_mode="$(psql_c 'SHOW archive_mode')"
if [ "$wal_level" != "replica" ] || [ "$archive_mode" != "on" ]; then
    echo "ERROR: unexpected settings after restart: wal_level=$wal_level archive_mode=$archive_mode" >&2
    exit 1
fi

if [ "${SKIP_ANALYZE:-0}" != "1" ]; then
    docker exec "$CONTAINER" vacuumdb -U "$DB_USER" -d "$DB_NAME" --analyze-only --jobs=4
fi

# 切り替えた WAL セグメント自体がアーカイブされたことを確認する。
# pg_switch_wal() は切り替え先の先頭 LSN を返すため、1 引いて切り替えたセグメントの名前にする。
segment="$(psql_c 'SELECT pg_walfile_name(pg_switch_wal() - 1)')"
archived=f
for _ in $(seq 1 30); do
    archived="$(psql_c "SELECT coalesce(last_archived_wal >= '$segment', false) FROM pg_stat_archiver")"
    [ "$archived" = t ] && break
    sleep 2
done
failed="$(psql_c 'SELECT failed_count FROM pg_stat_archiver')"
if [ "$archived" != t ] || [ "$failed" -ne 0 ]; then
    echo "ERROR: WAL archiving is not healthy: segment=$segment archived=$archived failed_count=$failed" >&2
    exit 1
fi

name="base-$(date -u +%Y%m%dT%H%M%SZ)"
docker exec "$CONTAINER" pg_basebackup -U "$DB_USER" -D "/backup/$name" -Fp -X stream -c fast -P
docker exec "$CONTAINER" pg_verifybackup "/backup/$name"

echo "steady-state ready. base backup: /backup/$name (host: ${NEW_DB_BACKUP_HOST_PATH:-/mnt/ssd/twitter-accounts-classifier/postgres-new-backup}/$name)"
