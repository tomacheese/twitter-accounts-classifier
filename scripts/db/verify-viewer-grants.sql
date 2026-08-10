-- viewer の権限が最小権限方針 (原則 SELECT のみ、ComponentBuildIdentity は INSERT/UPDATE 可) に一致することを、
-- データを書き換えず検証する。psql で対象 DB へ接続し、このファイルを実行する。
-- 条件違反時は例外で終了する。

DO $$
DECLARE
  unreadable_tables text;
  limited_write_allowlist text[] := ARRAY['ComponentBuildIdentity'];
  missing_limited_writes text;
  unexpected_limited_deletes text;
  write_tables text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'viewer') THEN
    RAISE EXCEPTION 'role viewer does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'viewer'
      AND 'client_connection_check_interval=5s' = ANY(COALESCE(rolconfig, ARRAY[]::text[]))
  ) THEN
    RAISE EXCEPTION 'viewer client_connection_check_interval must be 5s';
  END IF;

  IF NOT has_database_privilege('viewer', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'viewer lacks CONNECT on database %', current_database();
  END IF;

  IF NOT has_schema_privilege('viewer', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'viewer lacks USAGE on schema public';
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
  INTO unreadable_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND NOT has_table_privilege(
      'viewer', format('%I.%I', n.nspname, c.relname), 'SELECT'
    );

  IF unreadable_tables IS NOT NULL THEN
    RAISE EXCEPTION 'viewer lacks SELECT on: %', unreadable_tables;
  END IF;

  SELECT string_agg(t, ', ')
  INTO missing_limited_writes
  FROM unnest(limited_write_allowlist) AS t
  WHERE to_regclass(format('public.%I', t)) IS NOT NULL
    AND NOT has_table_privilege('viewer', format('public.%I', t), 'INSERT, UPDATE');

  IF missing_limited_writes IS NOT NULL THEN
    RAISE EXCEPTION 'viewer lacks INSERT/UPDATE on limited-write tables: %',
      missing_limited_writes;
  END IF;

  SELECT string_agg(t, ', ')
  INTO unexpected_limited_deletes
  FROM unnest(limited_write_allowlist) AS t
  WHERE to_regclass(format('public.%I', t)) IS NOT NULL
    AND has_table_privilege('viewer', format('public.%I', t), 'DELETE');

  IF unexpected_limited_deletes IS NOT NULL THEN
    RAISE EXCEPTION 'viewer has unexpected DELETE on limited-write tables: %',
      unexpected_limited_deletes;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
  INTO write_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND NOT (c.relname = ANY (limited_write_allowlist))
    AND has_table_privilege(
      'viewer',
      format('%I.%I', n.nspname, c.relname),
      'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
    );

  IF write_tables IS NOT NULL THEN
    RAISE EXCEPTION 'viewer has unexpected write privileges on: %', write_tables;
  END IF;

  IF to_regclass('public."ReviewFinding"') IS NOT NULL
    AND NOT has_table_privilege('viewer', 'public."ReviewFinding"', 'SELECT') THEN
    RAISE EXCEPTION 'viewer is missing SELECT on ReviewFinding';
  END IF;
END
$$;

SELECT 'viewer grants verified' AS result;
