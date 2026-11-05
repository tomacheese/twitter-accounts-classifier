-- target: "ReadModelState"
-- columns: "modelKey", "schemaVersion", "status", "currentGenerationId", "sourceWatermarkAt", "lastStartedAt", "lastSuccessAt", "lastFailureAt", "expectedNextAt", "delayedAt", "staleAt", "rowCount", "policyHash", "analyzerVersion", "errorCode", "errorSummary"
-- scope: none
-- big: no
SELECT
  t."modelKey",
  t."schemaVersion",
  t."status",
  t."currentGenerationId",
  t."sourceWatermarkAt" AT TIME ZONE 'UTC',
  t."lastStartedAt" AT TIME ZONE 'UTC',
  t."lastSuccessAt" AT TIME ZONE 'UTC',
  t."lastFailureAt" AT TIME ZONE 'UTC',
  t."expectedNextAt" AT TIME ZONE 'UTC',
  t."delayedAt" AT TIME ZONE 'UTC',
  t."staleAt" AT TIME ZONE 'UTC',
  t."rowCount",
  t."policyHash",
  t."analyzerVersion",
  t."errorCode",
  t."errorSummary"
FROM "ReadModelState" t
WHERE :scope
