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

analysis_work_item_privileges() {
  psql -At "$DATABASE_URL" -c \
    "SELECT has_table_privilege('weekly_review', 'public.\"AnalysisWorkItem\"', 'SELECT')::text || ':' || has_table_privilege('weekly_review', 'public.\"AnalysisWorkItem\"', 'INSERT')::text || ':' || has_table_privilege('weekly_review', 'public.\"AnalysisWorkItem\"', 'UPDATE')::text || ':' || has_table_privilege('weekly_review', 'public.\"AnalysisWorkItem\"', 'DELETE')::text"
}

viewer_component_build_identity_privileges() {
  psql -At "$DATABASE_URL" -c \
    "SELECT has_table_privilege('viewer', 'public.\"ComponentBuildIdentity\"', 'SELECT')::text || ':' || has_table_privilege('viewer', 'public.\"ComponentBuildIdentity\"', 'INSERT')::text || ':' || has_table_privilege('viewer', 'public.\"ComponentBuildIdentity\"', 'UPDATE')::text || ':' || has_table_privilege('viewer', 'public.\"ComponentBuildIdentity\"', 'DELETE')::text"
}

analyzer_component_build_identity_privileges() {
  psql -At "$DATABASE_URL" -c \
    "SELECT has_table_privilege('analyzer', 'public.\"ComponentBuildIdentity\"', 'SELECT')::text || ':' || has_table_privilege('analyzer', 'public.\"ComponentBuildIdentity\"', 'INSERT')::text || ':' || has_table_privilege('analyzer', 'public.\"ComponentBuildIdentity\"', 'UPDATE')::text || ':' || has_table_privilege('analyzer', 'public.\"ComponentBuildIdentity\"', 'DELETE')::text"
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
test "$(viewer_component_build_identity_privileges)" = "true:true:true:false"
test "$(analyzer_component_build_identity_privileges)" = "true:true:true:false"

# 新 compose 相当: password を渡した再実行で LOGIN ロールへ安全に昇格する。
(
  cd /tmp
  VIEWER_DB_PASSWORD=ci-viewer-password \
  ANALYZER_DB_PASSWORD=ci-analyzer-password \
    bash "$REPO_ROOT/scripts/db/run-migration-and-sync-grants.sh"
)

test "$(role_state viewer)" = "true:true"
test "$(role_state analyzer)" = "true:true"

# weekly_review が存在しないケースだけでは write allowlist の退行を検出できないため、存在するケースも検証する。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "CREATE ROLE weekly_review NOLOGIN"
(
  cd /tmp
  VIEWER_DB_PASSWORD=ci-viewer-password \
  ANALYZER_DB_PASSWORD=ci-analyzer-password \
    bash "$REPO_ROOT/scripts/db/run-migration-and-sync-grants.sh"
)

test "$(analysis_work_item_privileges)" = "true:true:false:false"

# grant sync が途中で落ちても、REVOKE だけが残って write allowlist を壊さないことを検証する。
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c 'GRANT UPDATE ON TABLE "AnalysisWorkItem" TO weekly_review'
INTERRUPTED_SYNC_SQL="$(mktemp)"
trap 'rm -f "$INTERRUPTED_SYNC_SQL"' EXIT
sed '/^COMMIT;$/i SELECT 1 / 0;' "$REPO_ROOT/scripts/db/sync-weekly-review-grants.sql" > "$INTERRUPTED_SYNC_SQL"
if psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$INTERRUPTED_SYNC_SQL" >/dev/null 2>&1; then
  echo "weekly_review grant sync must fail at the injected error" >&2
  exit 1
fi
test "$(analysis_work_item_privileges)" = "true:true:true:false"
psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -f "$REPO_ROOT/scripts/db/sync-weekly-review-grants.sql" >/dev/null
test "$(analysis_work_item_privileges)" = "true:true:false:false"

psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "DROP OWNED BY weekly_review; DROP ROLE weekly_review"
