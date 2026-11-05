-- target: "ReviewFinding"
-- columns: "id", "fingerprint", "identityVersion", "episodeNumber", "type", "primaryScopeType", "primaryScopeId", "status", "currentSeverity", "maximumSeverity", "firstDetectedAt", "lastDetectedAt", "resolvedAt", "recurrenceCount", "previousFindingId", "supersededByFindingId", "currentOccurrenceId"
-- scope: none
-- big: no
SELECT
  t."id",
  t."fingerprint",
  t."identityVersion",
  t."episodeNumber",
  t."type",
  t."primaryScopeType",
  t."primaryScopeId",
  t."status",
  t."currentSeverity",
  t."maximumSeverity",
  t."firstDetectedAt" AT TIME ZONE 'UTC',
  t."lastDetectedAt" AT TIME ZONE 'UTC',
  t."resolvedAt" AT TIME ZONE 'UTC',
  t."recurrenceCount",
  t."previousFindingId",
  t."supersededByFindingId",
  t."currentOccurrenceId"
FROM "ReviewFinding" t
WHERE :scope
