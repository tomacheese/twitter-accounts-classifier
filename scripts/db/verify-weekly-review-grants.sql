-- weekly_review の権限が最小権限方針に一致することを、データを書き換えず検証する。
-- psql で対象DBへ接続し、このファイルを実行する。条件違反時は例外で終了する。

DO $$
DECLARE
  unreadable_tables text;
  unexpected_write_tables text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'weekly_review') THEN
    RAISE EXCEPTION 'role weekly_review does not exist';
  END IF;

  IF NOT has_database_privilege('weekly_review', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'weekly_review lacks CONNECT on database %', current_database();
  END IF;

  IF NOT has_schema_privilege('weekly_review', 'public', 'USAGE') THEN
    RAISE EXCEPTION 'weekly_review lacks USAGE on schema public';
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
  INTO unreadable_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND NOT has_table_privilege(
      'weekly_review', format('%I.%I', n.nspname, c.relname), 'SELECT'
    );

  IF unreadable_tables IS NOT NULL THEN
    RAISE EXCEPTION 'weekly_review lacks SELECT on: %', unreadable_tables;
  END IF;

  IF to_regclass('public."WeeklyAnalysisRun"') IS NULL THEN
    RAISE EXCEPTION 'required table public."WeeklyAnalysisRun" does not exist';
  END IF;
  IF to_regclass('public."AnalysisWorkItem"') IS NULL THEN
    RAISE EXCEPTION 'required table public."AnalysisWorkItem" does not exist';
  END IF;

  IF NOT has_table_privilege('weekly_review', 'public."WeeklyAnalysisRun"', 'INSERT') THEN
    RAISE EXCEPTION 'weekly_review lacks INSERT on WeeklyAnalysisRun';
  END IF;
  IF NOT has_table_privilege('weekly_review', 'public."WeeklyAnalysisRun"', 'UPDATE') THEN
    RAISE EXCEPTION 'weekly_review lacks UPDATE on WeeklyAnalysisRun';
  END IF;
  IF has_table_privilege(
    'weekly_review', 'public."WeeklyAnalysisRun"', 'DELETE, TRUNCATE, REFERENCES, TRIGGER'
  ) THEN
    RAISE EXCEPTION 'weekly_review has excessive write privileges on WeeklyAnalysisRun';
  END IF;

  IF NOT has_table_privilege('weekly_review', 'public."AnalysisWorkItem"', 'INSERT') THEN
    RAISE EXCEPTION 'weekly_review lacks INSERT on AnalysisWorkItem';
  END IF;
  IF has_table_privilege(
    'weekly_review', 'public."AnalysisWorkItem"', 'UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
  ) THEN
    RAISE EXCEPTION 'weekly_review has excessive write privileges on AnalysisWorkItem';
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
  INTO unexpected_write_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND c.relname NOT IN ('WeeklyAnalysisRun', 'AnalysisWorkItem')
    AND has_table_privilege(
      'weekly_review',
      format('%I.%I', n.nspname, c.relname),
      'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
    );

  IF unexpected_write_tables IS NOT NULL THEN
    RAISE EXCEPTION 'weekly_review has write privileges on read-only tables: %',
      unexpected_write_tables;
  END IF;
END
$$;

SELECT 'weekly_review grants verified' AS result;
