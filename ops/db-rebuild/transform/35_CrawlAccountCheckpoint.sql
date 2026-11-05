-- target: "CrawlAccountCheckpoint"
-- columns: "id", "crawlRunId", "username", "phase", "data", "completedAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."crawlRunId",
  t."username",
  t."phase",
  t."data",
  t."completedAt" AT TIME ZONE 'UTC'
FROM "CrawlAccountCheckpoint" t
WHERE :scope
