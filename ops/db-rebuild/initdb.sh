#!/bin/bash
# 新 DB のデータディレクトリを初期化する (一度だけ実行する)。
# initdb の設定は後から変更できないため、ここで固定する。
# 使い方: NEW_DB_PASSWORD=<パスワード> ops/db-rebuild/initdb.sh
# 環境変数は compose.new-db.yaml と共通 (NEW_DB_DATA_HOST_PATH など)。
set -euo pipefail

IMAGE="${NEW_DB_IMAGE:-postgres:17-alpine}"
DATA="${NEW_DB_DATA_HOST_PATH:-/mnt/ssd/twitter-accounts-classifier/postgres-new}"
WAL_ARCHIVE="${NEW_DB_WAL_ARCHIVE_HOST_PATH:-/mnt/ssd/twitter-accounts-classifier/postgres-new-wal-archive}"
BACKUP="${NEW_DB_BACKUP_HOST_PATH:-/mnt/ssd/twitter-accounts-classifier/postgres-new-backup}"
DB_USER="${NEW_DB_USER:-tac_owner}"
DB_NAME="${NEW_DB_NAME:-twitter_accounts_classifier}"
# 既知の既定パスワードを持たせない。superuser のパスワードになる。
: "${NEW_DB_PASSWORD:?NEW_DB_PASSWORD must be set}"

mkdir -p "$DATA" "$WAL_ARCHIVE" "$BACKUP"

# 初期化済みのディレクトリは uid 70 の 0700 でホストから中身を見られないため、空かどうかはコンテナ内で判定する。
# 前回の試行の残り (WAL アーカイブ、バックアップ) があると、アーカイブが同名ファイルで失敗するため、3 つとも空を要求する。
docker run --rm --user root \
    -v "$DATA":/check/data:ro -v "$WAL_ARCHIVE":/check/wal:ro -v "$BACKUP":/check/backup:ro \
    --entrypoint sh "$IMAGE" -euc '
        for d in /check/data /check/wal /check/backup; do
            if [ -n "$(ls -A "$d")" ]; then
                echo "ERROR: $d is not empty; refusing to initialize" >&2
                exit 1
            fi
        done
    '

# postgres:alpine の postgres ユーザーは uid 70。所有者と権限は root のコンテナ内で整える。
# パスワードはコマンドラインに載せないよう、値なしの -e で環境変数を引き継ぐ。
export DB_PASSWORD="$NEW_DB_PASSWORD"
docker run --rm --user root \
    -e DB_USER="$DB_USER" -e DB_NAME="$DB_NAME" -e DB_PASSWORD \
    -v "$DATA":/var/lib/postgresql/data \
    -v "$WAL_ARCHIVE":/wal-archive \
    -v "$BACKUP":/backup \
    --entrypoint sh "$IMAGE" -euc '
        chown 70:70 /var/lib/postgresql/data /wal-archive /backup
        chmod 700 /var/lib/postgresql/data /wal-archive /backup
        umask 077
        printf "%s" "$DB_PASSWORD" > /tmp/pwfile
        chown postgres /tmp/pwfile

        gosu postgres initdb -D /var/lib/postgresql/data \
            --data-checksums \
            --encoding=UTF8 \
            --locale-provider=builtin \
            --locale=C.UTF-8 \
            --builtin-locale=C.UTF-8 \
            --username="$DB_USER" --pwfile=/tmp/pwfile \
            --auth-local=trust --auth-host=scram-sha-256

        # 一時サーバー (ソケットのみ) でデータベースと拡張だけ作る。設定は conf/ の本番用に任せる。
        gosu postgres pg_ctl -D /var/lib/postgresql/data -w \
            -o "-c listen_addresses= -c shared_preload_libraries=pg_stat_statements" start
        gosu postgres createdb -U "$DB_USER" "$DB_NAME"
        gosu postgres psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 \
            -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" \
            -c "CREATE EXTENSION IF NOT EXISTS pg_trgm"
        gosu postgres pg_ctl -D /var/lib/postgresql/data -w stop
        rm -f /tmp/pwfile
    '

echo "initdb done: $DATA"
