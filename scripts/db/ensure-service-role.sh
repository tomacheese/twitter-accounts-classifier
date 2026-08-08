#!/bin/bash
set -euo pipefail

ensure_service_role() {
  local role="$1"
  local password="${2:-}"

  psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -v role="$role" <<'SQL'
SELECT format('CREATE ROLE %I NOLOGIN', :'role')
WHERE NOT EXISTS (
  SELECT 1 FROM pg_roles WHERE rolname = :'role'
) \gexec
SQL

  # 旧 compose では専用ロールの password が渡らないため、未指定時は既存設定を変更しない。
  if [ -z "$password" ]; then
    return
  fi

  ROLE_PASSWORD="$password" psql -v ON_ERROR_STOP=1 "$DATABASE_URL" -v role="$role" <<'SQL'
\getenv role_password ROLE_PASSWORD
SELECT format(
  'ALTER ROLE %I WITH LOGIN PASSWORD %L',
  :'role', :'role_password'
) \gexec
SQL
}

role_exists() {
  local role="$1"
  local exists
  exists="$(psql -At -v ON_ERROR_STOP=1 "$DATABASE_URL" -v role="$role" <<'SQL'
SELECT 1 FROM pg_roles WHERE rolname = :'role';
SQL
)"
  test "$exists" = "1"
}
