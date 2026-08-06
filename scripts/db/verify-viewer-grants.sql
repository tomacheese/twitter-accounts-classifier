-- viewer の権限が最小権限方針 (SELECT のみ) に一致することを、
-- データを書き換えず検証する。psql で対象DBへ接続し、このファイルを実行する。
-- 条件違反時は例外で終了する。

DO $$
DECLARE
  unreadable_tables text;
  write_tables text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'viewer') THEN
    RAISE EXCEPTION 'role viewer does not exist';
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

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
  INTO write_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
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
