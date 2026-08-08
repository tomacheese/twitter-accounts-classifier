#!/bin/bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"

role_state() {
  local role="$1"
  psql -At "$DATABASE_URL" -c \
    "SELECT rolcanlogin::text || ':' || (rolpassword IS NOT NULL)::text FROM pg_authid WHERE rolname = '${role}'"
}

if psql -At "$DATABASE_URL" -c "SELECT rolname FROM pg_roles WHERE rolname IN ('viewer', 'analyzer')" | grep -q .; then
  echo "viewer/analyzer must not exist before this test" >&2
  exit 1
fi

# 旧 compose 相当: password 環境変数がない状態でも migration/grant 同期を止めない。
(
  cd /tmp
  env -u VIEWER_DB_PASSWORD -u ANALYZER_DB_PASSWORD \
    bash "$REPO_ROOT/scripts/db/run-migration-and-sync-grants.sh"
)

test "$(role_state viewer)" = "false:false"
test "$(role_state analyzer)" = "false:false"
test -z "$(psql -At "$DATABASE_URL" -c "SELECT rolname FROM pg_roles WHERE rolname = 'weekly_review'")"

# 新 compose 相当: password を渡した再実行で LOGIN ロールへ安全に昇格する。
(
  cd /tmp
  VIEWER_DB_PASSWORD=ci-viewer-password \
  ANALYZER_DB_PASSWORD=ci-analyzer-password \
    bash "$REPO_ROOT/scripts/db/run-migration-and-sync-grants.sh"
)

test "$(role_state viewer)" = "true:true"
test "$(role_state analyzer)" = "true:true"
