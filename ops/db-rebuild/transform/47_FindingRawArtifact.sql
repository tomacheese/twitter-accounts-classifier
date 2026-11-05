-- target: "FindingRawArtifact"
-- columns: "id", "findingId", "kind", "content", "isTruncated", "createdAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."findingId",
  t."kind",
  t."content",
  t."isTruncated",
  t."createdAt" AT TIME ZONE 'UTC'
FROM "FindingRawArtifact" t
WHERE :scope
