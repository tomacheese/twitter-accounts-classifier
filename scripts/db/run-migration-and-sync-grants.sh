#!/bin/bash
set -euo pipefail

# baseline の適用後、サービス用ロール (crawler、viewer、analyzer) の作成・権限同期・検証をまとめて行う。
# 各ロールは password 未指定時は NOLOGIN で作成し、password が渡された時点で LOGIN ロールへ昇格する。
# weekly_review は外部開発機向けの任意ロールなので、未作成環境では同期をスキップする。

# -v ON_ERROR_STOP=1 を付けないと、RAISE EXCEPTION で失敗を通知する
# verify-*.sql が実行時エラーになっても psql は終了コード 0 を返し、
# set -e によるデプロイ停止が機能しない。

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ensure-service-role.sh"

ensure_service_role crawler "${CRAWLER_DB_PASSWORD:-}"
ensure_service_role viewer "${VIEWER_DB_PASSWORD:-}"
ensure_service_role analyzer "${ANALYZER_DB_PASSWORD:-}"

psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/sync-crawler-grants.sql"
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/sync-crawler-runtime-settings.sql"
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/verify-crawler-runtime-settings.sql"

psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/sync-viewer-grants.sql"
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/sync-analyzer-grants.sql"
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/verify-crawler-grants.sql"
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/verify-viewer-grants.sql"
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/verify-analyzer-grants.sql"

if role_exists weekly_review; then
  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/sync-weekly-review-grants.sql"
  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/verify-weekly-review-grants.sql"
else
  echo "weekly_review role is absent; skipping optional grant sync"
fi

echo "grant sync and verification succeeded"
