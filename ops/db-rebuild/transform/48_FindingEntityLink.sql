-- target: "FindingEntityLink"
-- columns: "id", "findingId", "entityType", "entityId"
-- scope: none
-- big: no
SELECT
  t."id",
  t."findingId",
  t."entityType",
  t."entityId"
FROM "FindingEntityLink" t
WHERE :scope
