CREATE TABLE "CrawlAuthorCheckpoint" (
    "id" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "profileCount" INTEGER NOT NULL DEFAULT 0,
    "labelsAppliedCount" INTEGER NOT NULL DEFAULT 0,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "durationMs" INTEGER,
    "retryWaitMs" INTEGER,
    "appVersion" TEXT NOT NULL DEFAULT 'unknown',
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlAuthorCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CrawlAuthorCheckpoint_crawlRunId_username_authorId_key" ON "CrawlAuthorCheckpoint"("crawlRunId", "username", "authorId");

CREATE INDEX "CrawlAuthorCheckpoint_crawlRunId_username_idx" ON "CrawlAuthorCheckpoint"("crawlRunId", "username");

ALTER TABLE "CrawlAuthorCheckpoint" ADD CONSTRAINT "CrawlAuthorCheckpoint_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "CrawlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
