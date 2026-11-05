-- target: "BlockRun"
-- columns: "id", "startedAt", "lastHeartbeatAt", "finishedAt", "status", "staleAfterAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."startedAt" AT TIME ZONE 'UTC',
  t."lastHeartbeatAt" AT TIME ZONE 'UTC',
  t."finishedAt" AT TIME ZONE 'UTC',
  t."status",
  t."staleAfterAt" AT TIME ZONE 'UTC'
FROM "BlockRun" t
WHERE :scope
