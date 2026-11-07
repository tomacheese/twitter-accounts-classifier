-- target: "OperationalIssue"
-- columns: "id", "component", "type", "fingerprint", "status", "severity", "firstDetectedAt", "lastDetectedAt", "resolvedAt", "currentOccurrenceId", "sourceCycleId", "sourceStageId"
-- scope: none
-- big: no
SELECT
  t."id",
  t."component",
  t."type",
  t."fingerprint",
  t."status",
  t."severity",
  t."firstDetectedAt" AT TIME ZONE 'UTC',
  t."lastDetectedAt" AT TIME ZONE 'UTC',
  t."resolvedAt" AT TIME ZONE 'UTC',
  t."currentOccurrenceId",
  t."sourceCycleId",
  t."sourceStageId"
FROM "OperationalIssue" t
WHERE :scope
