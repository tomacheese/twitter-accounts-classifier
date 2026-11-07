-- target: "AccountClassificationReasonCount"
-- columns: "labelDefinitionId", "reason", "count"
-- scope: none
-- big: no
SELECT
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."reason",
  t."count"
FROM "AccountClassificationReasonCount" t
WHERE :scope
