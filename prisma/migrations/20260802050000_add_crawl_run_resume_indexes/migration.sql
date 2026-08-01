-- 再開対象の最新の running run を取得する。このファイルは Prisma 6 で
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "CrawlRun_status_startedAt_id_idx"
ON "CrawlRun" ("status", "startedAt" DESC, "id" DESC);
