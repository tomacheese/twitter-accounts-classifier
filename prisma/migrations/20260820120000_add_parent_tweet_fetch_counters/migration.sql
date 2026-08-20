ALTER TABLE "CrawlAuthorCheckpoint"
ADD COLUMN "parentTweetFetchRequestCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "parentTweetFetchRateLimitRemaining" INTEGER,
ADD COLUMN "parentTweetFetchRateLimitReset" INTEGER;

ALTER TABLE "CrawlAccountRun"
ADD COLUMN "parentTweetFetchCount" INTEGER NOT NULL DEFAULT 0;
