-- crawler ロール (crawler、relabeler、blocker、storage-guard が共用する) の権限を冪等に同期する。
-- 所有者ロールで、baseline の適用後に毎回実行する。
-- crawler が所有者や superuser だと、下の REVOKE が効かず set_label_result を迂回した直接 DML ができてしまう。
-- 所有者とは別の NOSUPERUSER ロールで接続させること。

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crawler') THEN
    RAISE EXCEPTION 'role crawler does not exist; create it before syncing grants';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crawler' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'role crawler must be NOSUPERUSER NOBYPASSRLS for the label write restriction to take effect';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'crawler') THEN
    RAISE EXCEPTION 'role crawler must not own tables; run the baseline with a separate owner role';
  END IF;
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO crawler', current_database());
END
$$;

GRANT USAGE ON SCHEMA public TO crawler;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO crawler;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO crawler;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO crawler;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO crawler;

-- ラベル状態への書き込みは set_label_result (SECURITY DEFINER) だけに閉じる。
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON "AccountLabelState", "AccountActiveLabel" FROM crawler;
-- 監査ログも、トリガー (SECURITY DEFINER) だけが書く。crawler が直接書いて改ざんできないようにする。
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON "AccountLabelChange" FROM crawler;
GRANT EXECUTE ON FUNCTION set_label_result(
  bigint[], smallint[], integer[], smallint[], smallint[], double precision[], text[], text[],
  timestamptz, smallint, text, text
) TO crawler;

COMMIT;
