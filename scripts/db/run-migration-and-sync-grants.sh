#!/bin/bash
set -euo pipefail

# migration 実行後、サービス用ロールの作成・権限同期・検証をまとめて行う。
# viewer/analyzer は旧 compose との互換性のため password 未指定時は NOLOGIN で作成し、
# 新 compose から password が渡された時点で LOGIN ロールへ昇格する。
# weekly_review は外部開発機向けの任意ロールなので、未作成環境では同期をスキップする。

# -v ON_ERROR_STOP=1 を付けないと、RAISE EXCEPTION で失敗を通知する
# verify-*.sql が実行時エラーになっても psql は終了コード 0 を返し、
# set -e によるデプロイ停止が機能しない。

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/ensure-service-role.sh"

ensure_service_role viewer "${VIEWER_DB_PASSWORD:-}"
ensure_service_role analyzer "${ANALYZER_DB_PASSWORD:-}"

psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/sync-viewer-grants.sql"
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/sync-analyzer-grants.sql"
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/verify-viewer-grants.sql"
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/verify-analyzer-grants.sql"

if role_exists weekly_review; then
  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/sync-weekly-review-grants.sql"
  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$SCRIPT_DIR/verify-weekly-review-grants.sql"
else
  echo "weekly_review role is absent; skipping optional grant sync"
fi

echo "grant sync and verification succeeded"
