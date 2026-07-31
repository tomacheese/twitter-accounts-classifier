-- weekly-crawl-review スキルが開発機から接続するための最小権限ロール。
-- 本番機の Postgres に対して、psql または任意の DB クライアントから
-- 一度だけ手動実行すること (このリポジトリの migrate では管理しない —
-- Prisma migrate はスキーマのみを対象とし、ロール/権限管理には使わない)。
--
-- 実行前に CHANGE_ME_WEEKLY_REVIEW_PASSWORD を実際の強いパスワードに
-- 置き換えること。置き換えたパスワードは開発機の .env.weekly-review にも
-- 設定する (このリポジトリには含めない)。

CREATE ROLE weekly_review WITH LOGIN PASSWORD 'CHANGE_ME_WEEKLY_REVIEW_PASSWORD';

GRANT CONNECT ON DATABASE twitter_accounts_classifier TO weekly_review;

GRANT SELECT ON "Account" TO weekly_review;
GRANT SELECT ON "Tweet" TO weekly_review;
GRANT SELECT ON "AccountLabel" TO weekly_review;
GRANT SELECT ON "LabelDefinition" TO weekly_review;
GRANT SELECT, INSERT, UPDATE ON "WeeklyAnalysisRun" TO weekly_review;

-- pg_hba.conf 側で weekly_review ロールの開発機 IP からの TCP 接続を許可し、
-- crawler ロールは Docker 内部ネットワークからのみ許可すること
-- (spec セクション9・13参照。pg_hba.conf の実際の編集は本番機側の運用作業のため、
-- このリポジトリのスコープ外)。
