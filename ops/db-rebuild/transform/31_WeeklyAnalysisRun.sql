-- target: "WeeklyAnalysisRun"
-- columns: "id", "startedAt", "lastHeartbeatAt", "finishedAt", "staleAfterAt", "status", "currentPhase", "errorMessage", "pullRequestNumber", "pullRequestUrl", "sampledAccountIds", "findings", "commitSha", "targetFrom", "targetTo", "analysisVersion", "modelIdentity", "toolIdentity", "policyHash", "reviewPlan", "structuredOutput"
-- scope: none
-- big: no
SELECT
  t."id",
  t."startedAt" AT TIME ZONE 'UTC',
  t."lastHeartbeatAt" AT TIME ZONE 'UTC',
  t."finishedAt" AT TIME ZONE 'UTC',
  t."staleAfterAt" AT TIME ZONE 'UTC',
  t."status",
  t."currentPhase",
  t."errorMessage",
  t."pullRequestNumber",
  t."pullRequestUrl",
  t."sampledAccountIds",
  t."findings",
  t."commitSha",
  t."targetFrom" AT TIME ZONE 'UTC',
  t."targetTo" AT TIME ZONE 'UTC',
  t."analysisVersion",
  t."modelIdentity",
  t."toolIdentity",
  t."policyHash",
  t."reviewPlan",
  t."structuredOutput"
FROM "WeeklyAnalysisRun" t
WHERE :scope
