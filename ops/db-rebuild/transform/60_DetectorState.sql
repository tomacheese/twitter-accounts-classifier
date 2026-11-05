-- target: "DetectorState"
-- columns: "detectorKey", "lastEvidenceEpochId", "sourceWatermarkAt", "lastStartedAt", "lastSuccessAt", "lastFailureAt", "errorCode", "errorSummary", "policyHash", "analyzerVersion", "updatedAt"
-- scope: none
-- big: no
SELECT
  t."detectorKey",
  t."lastEvidenceEpochId",
  t."sourceWatermarkAt" AT TIME ZONE 'UTC',
  t."lastStartedAt" AT TIME ZONE 'UTC',
  t."lastSuccessAt" AT TIME ZONE 'UTC',
  t."lastFailureAt" AT TIME ZONE 'UTC',
  t."errorCode",
  t."errorSummary",
  t."policyHash",
  t."analyzerVersion",
  t."updatedAt" AT TIME ZONE 'UTC'
FROM "DetectorState" t
WHERE :scope
