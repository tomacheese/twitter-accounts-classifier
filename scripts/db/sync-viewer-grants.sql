-- viewer の権限を、現在のスキーマへ冪等に同期する。
-- Prisma migration を実行するテーブル所有者ロールで、migration後に毎回実行する。
-- 方針: public の全テーブルを読める。write は一切許可しない。

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'viewer') THEN
    RAISE EXCEPTION 'role viewer does not exist; create it before syncing grants';
  END IF;

  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO viewer',
    current_database()
  );
END
$$;

GRANT USAGE ON SCHEMA public TO viewer;

-- 過去の個別GRANTや設定変更で増えたwrite権限を一度除去する。
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public
  FROM viewer;
REVOKE ALL PRIVILEGES
  ON ALL SEQUENCES IN SCHEMA public
  FROM viewer;

-- 現在存在する全テーブル・view・materialized viewを読み取り可能にする。
GRANT SELECT ON ALL TABLES IN SCHEMA public TO viewer;

-- 以後、このSQLを実行した所有者が作るテーブルにも同じread方針を適用する。
-- テーブル入れ替えmigrationでも新オブジェクトへSELECTが自動付与される。
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES FROM viewer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO viewer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM viewer;
