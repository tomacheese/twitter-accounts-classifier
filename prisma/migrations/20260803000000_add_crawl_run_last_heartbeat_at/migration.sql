ALTER TABLE "CrawlRun" ADD COLUMN "lastHeartbeatAt" TIMESTAMP(3);
UPDATE "CrawlRun" SET "lastHeartbeatAt" = "startedAt" WHERE "lastHeartbeatAt" IS NULL;
ALTER TABLE "CrawlRun" ALTER COLUMN "lastHeartbeatAt" SET NOT NULL;
