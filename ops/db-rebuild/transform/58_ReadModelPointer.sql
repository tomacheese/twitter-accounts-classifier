-- target: "ReadModelPointer"
-- columns: "modelKey", "currentGenerationId", "switchedAt"
-- scope: none
-- big: no
SELECT
  t."modelKey",
  t."currentGenerationId",
  t."switchedAt" AT TIME ZONE 'UTC'
FROM "ReadModelPointer" t
WHERE :scope
