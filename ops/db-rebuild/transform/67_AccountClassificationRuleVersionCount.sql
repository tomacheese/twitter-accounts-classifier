-- target: "AccountClassificationRuleVersionCount"
-- columns: "labelDefinitionId", "ruleVersion", "count"
-- scope: none
-- big: no
SELECT
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."ruleVersion",
  t."count"
FROM "AccountClassificationRuleVersionCount" t
WHERE :scope
