-- account ごとに最新の試行を DISTINCT ON で取得する。このファイルは Prisma 6 で
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CrawlAccountRun_crawlRunId_username_startedAt_id_idx"
ON "CrawlAccountRun" ("crawlRunId", "username", "startedAt" DESC, "id" DESC);
