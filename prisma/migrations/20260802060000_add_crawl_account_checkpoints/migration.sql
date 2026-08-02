CREATE TABLE "CrawlAccountCheckpoint" (
    "id" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlAccountCheckpoint_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CrawlAccountCheckpoint_crawlRunId_username_phase_key" ON "CrawlAccountCheckpoint"("crawlRunId", "username", "phase");

CREATE INDEX "CrawlAccountCheckpoint_crawlRunId_username_idx" ON "CrawlAccountCheckpoint"("crawlRunId", "username");

ALTER TABLE "CrawlAccountCheckpoint" ADD CONSTRAINT "CrawlAccountCheckpoint_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "CrawlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "CrawlAccountLabelRun" (
    "id" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "labelDefinitionId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrawlAccountLabelRun_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CrawlAccountLabelRun_crawlRunId_username_accountId_labelDefinitionId_method_ruleVersion_key" ON "CrawlAccountLabelRun"("crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion");

ALTER TABLE "CrawlAccountLabelRun" ADD CONSTRAINT "CrawlAccountLabelRun_crawlRunId_fkey" FOREIGN KEY ("crawlRunId") REFERENCES "CrawlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
