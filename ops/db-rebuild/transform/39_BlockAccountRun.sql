-- target: "BlockAccountRun"
-- columns: "id", "blockRunId", "username", "startedAt", "finishedAt", "status", "candidatesCount", "blockedCount", "failedCount", "errorMessage"
-- scope: none
-- big: no
SELECT
  t."id",
  t."blockRunId",
  t."username",
  t."startedAt" AT TIME ZONE 'UTC',
  t."finishedAt" AT TIME ZONE 'UTC',
  t."status",
  t."candidatesCount",
  t."blockedCount",
  t."failedCount",
  t."errorMessage"
FROM "BlockAccountRun" t
WHERE :scope
