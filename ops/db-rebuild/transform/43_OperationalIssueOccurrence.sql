-- target: "OperationalIssueOccurrence"
-- columns: "id", "issueId", "observedAt", "stateTransition", "severity", "sourceType", "sourceId", "measurements", "observationKey"
-- scope: none
-- big: no
SELECT
  t."id",
  t."issueId",
  t."observedAt" AT TIME ZONE 'UTC',
  t."stateTransition",
  t."severity",
  t."sourceType",
  t."sourceId",
  t."measurements",
  t."observationKey"
FROM "OperationalIssueOccurrence" t
WHERE :scope
