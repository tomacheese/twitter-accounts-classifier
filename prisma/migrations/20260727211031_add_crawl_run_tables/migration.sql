-- CreateTable
CREATE TABLE "CrawlRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,

    CONSTRAINT "CrawlRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrawlAccountRun" (
    "id" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "recommendedCount" INTEGER NOT NULL DEFAULT 0,
    "followingCount" INTEGER NOT NULL DEFAULT 0,
    "trendingCount" INTEGER NOT NULL DEFAULT 0,
    "replyCount" INTEGER NOT NULL DEFAULT 0,
    "profileCount" INTEGER NOT NULL DEFAULT 0,
    "labelsAppliedCount" INTEGER NOT NULL DEFAULT 0,
    "followingSynced" BOOLEAN NOT NULL DEFAULT false,
    "followersSynced" BOOLEAN NOT NULL DEFAULT false,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "errorMessage" TEXT,

    CONSTRAINT "CrawlAccountRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CrawlRun_startedAt_idx" ON "CrawlRun"("startedAt");

-- CreateIndex
CREATE INDEX "CrawlAccountRun_crawlRunId_idx" ON "CrawlAccountRun"("crawlRunId");

-- CreateIndex
CREATE INDEX "CrawlAccountRun_startedAt_idx" ON "CrawlAccountRun"("startedAt");

-- AddForeignKey
ALTER TABLE "CrawlAccountRun" ADD CONSTRAINT "CrawlAccountRun_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "CrawlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
