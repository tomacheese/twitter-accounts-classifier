-- crawler ロールが、ラベル状態を set_label_result 経由でしか書けないことを、データを書き換えず検証する。
-- 条件違反時は例外で終了する。

DO $$
DECLARE
  v_table text;
  v_privilege text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crawler') THEN
    RAISE EXCEPTION 'role crawler does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crawler' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role crawler must be NOSUPERUSER NOBYPASSRLS';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'crawler') THEN
    RAISE EXCEPTION 'role crawler must not own tables';
  END IF;

  FOREACH v_table IN ARRAY ARRAY['AccountLabelState', 'AccountActiveLabel', 'AccountLabelChange'] LOOP
    FOREACH v_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER'] LOOP
      IF has_table_privilege('crawler', format('public.%I', v_table), v_privilege) THEN
        RAISE EXCEPTION 'crawler must not have % on %', v_privilege, v_table;
      END IF;
    END LOOP;
    IF NOT has_table_privilege('crawler', format('public.%I', v_table), 'SELECT') THEN
      RAISE EXCEPTION 'crawler must be able to SELECT from %', v_table;
    END IF;
  END LOOP;

  IF NOT has_function_privilege(
    'crawler',
    'set_label_result(bigint[], smallint[], integer[], smallint[], smallint[], double precision[], text[], text[], timestamptz, smallint, text, text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'crawler must be able to execute set_label_result';
  END IF;
END
$$;

SELECT 'crawler grants verified' AS result;
