#!/bin/bash
# 新スキーマ (prisma/baseline) の統合 smoke。使い捨ての DB を作り、本番と同じロール分離 (所有者、crawler、analyzer、viewer) で
# crawler の永続化と relabel、analyzer の read model 更新、viewer のアカウントページ向けクエリを順に通す。
# 実データは使わず、架空のアカウントとツイートだけを投入する。Twitter/X には接続しない。
#
# 使い方: SMOKE_CONFIRM_SCRATCH=1 SMOKE_ADMIN_URL=postgresql://<superuser>:<password>@<host>:<port>/postgres scripts/db/e2e-smoke.sh
# クラスタ全体のロール (crawler、analyzer、viewer) のパスワードを書き換えるため、本番では実行しない。
# 使い捨てのクラスタであることを SMOKE_CONFIRM_SCRATCH=1 で明示する。
set -euo pipefail

: "${SMOKE_ADMIN_URL:?SMOKE_ADMIN_URL must be set (a throwaway PostgreSQL cluster only)}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
DB="e2e_smoke_$$"
BASE="${SMOKE_ADMIN_URL%/*}"
scheme="${BASE%%://*}"
hostport="${BASE#*@}"

if [ "${SMOKE_CONFIRM_SCRATCH:-}" != "1" ]; then
    echo "ERROR: set SMOKE_CONFIRM_SCRATCH=1 to confirm the target is a throwaway cluster" >&2
    exit 1
fi

cleanup() {
    psql -X -q "$SMOKE_ADMIN_URL" -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql -X -q -v ON_ERROR_STOP=1 "$SMOKE_ADMIN_URL" -c "CREATE DATABASE $DB"
OWNER_URL="${SMOKE_ADMIN_URL%/*}/$DB"
DATABASE_URL="$OWNER_URL" "$ROOT/prisma/baseline/apply.sh"
DATABASE_URL="$OWNER_URL" CRAWLER_DB_PASSWORD=smoke-crawler VIEWER_DB_PASSWORD=smoke-viewer ANALYZER_DB_PASSWORD=smoke-analyzer \
    bash "$ROOT/scripts/db/run-migration-and-sync-grants.sh" >/dev/null

role_url() {
    echo "$scheme://$1:smoke-$1@$hostport/$DB"
}

export E2E_SMOKE=1
echo "== crawler: persistence and relabel cycle (crawler role)"
(cd "$ROOT/crawler" && DATABASE_URL="$(role_url crawler)" npx vitest run db-rebuild-smoke.integration.test.ts)
echo "== analyzer: queue drain and read models (analyzer role)"
(cd "$ROOT/analyzer" && DATABASE_URL="$(role_url analyzer)" npx vitest run db-rebuild-smoke.integration.test.ts)
echo "== viewer: account page queries (viewer role)"
(cd "$ROOT/viewer" && DATABASE_URL="$(role_url viewer)" npx vitest run lib/db-rebuild-smoke.integration.test.ts)
echo "E2E SMOKE PASSED"
