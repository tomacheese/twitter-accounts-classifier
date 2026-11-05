-- target: "FindingEvidence"
-- columns: "id", "findingId", "kind", "schemaVersion", "redactionVersion", "sampleStrategyVersion", "payload", "createdAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."findingId",
  t."kind",
  t."schemaVersion",
  t."redactionVersion",
  t."sampleStrategyVersion",
  t."payload",
  t."createdAt" AT TIME ZONE 'UTC'
FROM "FindingEvidence" t
WHERE :scope
