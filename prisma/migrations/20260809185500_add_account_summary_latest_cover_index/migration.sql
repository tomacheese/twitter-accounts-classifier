-- AccountSummaryLatest bootstrap scans Account in id order and reads lastCrawledAt.
-- Cover those columns so production HDD deployments avoid random heap reads per chunk.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Account_account_summary_latest_cover_idx"
ON "Account" ("id") INCLUDE ("screenName", "displayName", "lastCrawledAt");
