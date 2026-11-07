-- target: "AccountClassificationValueCount"
-- columns: "labelDefinitionId", "value", "count", "confidenceSum"
-- scope: none
-- big: no
SELECT
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."value",
  t."count",
  t."confidenceSum"
FROM "AccountClassificationValueCount" t
WHERE :scope
