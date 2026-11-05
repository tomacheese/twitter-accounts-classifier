-- target: "AccountClassificationLatest"
-- columns: "accountId", "observedAt", "labeledAt", "confidence", "labelDefinitionId", "value", "evaluable", "reason", "method", "ruleVersion", "sourceObservationId"
-- scope: accountId
-- big: ctid
SELECT
  t."accountId"::bigint,
  t."observedAt" AT TIME ZONE 'UTC',
  t."labeledAt" AT TIME ZONE 'UTC',
  t."confidence",
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."value",
  t."evaluable",
  t."reason",
  t."method",
  t."ruleVersion",
  t."sourceObservationId"
FROM "AccountClassificationLatest" t
WHERE :scope
