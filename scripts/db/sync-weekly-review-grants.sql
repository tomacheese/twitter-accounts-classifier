-- weekly_review の権限を、現在のスキーマへ冪等に同期する。
-- Prisma migration を実行するテーブル所有者ロールで、migration後に毎回実行する。
-- 方針: public の全テーブルは読める。書き込みは明示allowlistだけに限定する。

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'weekly_review') THEN
    RAISE EXCEPTION 'role weekly_review does not exist; create it before syncing grants';
  END IF;

  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO weekly_review',
    current_database()
  );
END
$$;

GRANT USAGE ON SCHEMA public TO weekly_review;

ALTER ROLE weekly_review SET client_connection_check_interval = '5s';
ALTER ROLE weekly_review SET statement_timeout = '120s';
ALTER ROLE weekly_review SET max_parallel_workers_per_gather = 0;

-- 過去の個別GRANTや設定変更で増えた直接write権限を一度除去する。
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public
  FROM weekly_review;
REVOKE ALL PRIVILEGES
  ON ALL SEQUENCES IN SCHEMA public
  FROM weekly_review;

-- 現在存在する全テーブル・view・materialized viewを読み取り可能にする。
GRANT SELECT ON ALL TABLES IN SCHEMA public TO weekly_review;

-- write allowlist。Weekly Reviewが実行記録を作成し、後からcommitShaを補完する。
GRANT INSERT, UPDATE ON TABLE "WeeklyAnalysisRun" TO weekly_review;

-- Prisma の空 update upsert に UPDATE 権限まで与える必要はないため、INSERT のみに限定する。
GRANT INSERT ON TABLE "AnalysisWorkItem" TO weekly_review;

-- 以後、このSQLを実行した所有者が作るテーブルにも同じread方針を適用する。
-- テーブル入れ替えmigrationでも新オブジェクトへSELECTが自動付与される。
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES FROM weekly_review;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO weekly_review;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM weekly_review;

-- write allowlistを増やす場合は、上の全体REVOKEより後へ明示GRANTを追加し、
-- verify-weekly-review-grants.sqlのallowlistも同時に更新する。

COMMIT;
