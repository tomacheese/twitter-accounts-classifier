-- target: "PolicyBacktestRun"
-- columns: "id", "candidatePolicyHash", "baselinePolicyHash", "targetFrom", "targetTo", "startedAt", "finishedAt", "status", "summary"
-- scope: none
-- big: no
SELECT
  t."id",
  t."candidatePolicyHash",
  t."baselinePolicyHash",
  t."targetFrom" AT TIME ZONE 'UTC',
  t."targetTo" AT TIME ZONE 'UTC',
  t."startedAt" AT TIME ZONE 'UTC',
  t."finishedAt" AT TIME ZONE 'UTC',
  t."status",
  t."summary"
FROM "PolicyBacktestRun" t
WHERE :scope
