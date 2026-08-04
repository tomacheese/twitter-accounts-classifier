-- Accounts ページの一覧はソートキー列 (followersCount / tweetCount / lastCrawledAt) にインデックスがないと、
-- テーブルが育つほど毎回のソートが重くなるため、この3列にインデックスを張る。
-- CONCURRENTLY は Postgres 側の制約でトランザクション内では実行できず、
-- prisma migrate deploy は各マイグレーションファイルを常にトランザクションで囲むため、
-- ここでは CONCURRENTLY を使わず通常の CREATE INDEX で作成する。
CREATE INDEX IF NOT EXISTS "Account_followersCount_idx"
ON "Account" ("followersCount");

CREATE INDEX IF NOT EXISTS "Account_tweetCount_idx"
ON "Account" ("tweetCount");

CREATE INDEX IF NOT EXISTS "Account_lastCrawledAt_idx"
ON "Account" ("lastCrawledAt");
