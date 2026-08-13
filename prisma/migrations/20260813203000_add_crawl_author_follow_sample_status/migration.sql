ALTER TABLE "CrawlAuthorCheckpoint"
ADD COLUMN "followSampleStatus" TEXT,
ADD COLUMN "followSampleRequestCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "followSampleRateLimitRemaining" INTEGER,
ADD COLUMN "followSampleRateLimitReset" INTEGER;
