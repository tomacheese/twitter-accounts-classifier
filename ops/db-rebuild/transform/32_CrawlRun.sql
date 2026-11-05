-- target: "CrawlRun"
-- columns: "id", "startedAt", "lastHeartbeatAt", "finishedAt", "status", "currentUsername", "currentAccountStartedAt", "staleAfterAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."startedAt" AT TIME ZONE 'UTC',
  t."lastHeartbeatAt" AT TIME ZONE 'UTC',
  t."finishedAt" AT TIME ZONE 'UTC',
  t."status",
  t."currentUsername",
  t."currentAccountStartedAt" AT TIME ZONE 'UTC',
  t."staleAfterAt" AT TIME ZONE 'UTC'
FROM "CrawlRun" t
WHERE :scope
