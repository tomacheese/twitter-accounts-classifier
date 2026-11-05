-- target: "AccountClassificationFreshnessBucket"
-- columns: "labelDefinitionId", "observedAtBucket", "count"
-- scope: none
-- big: no
SELECT
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."observedAtBucket" AT TIME ZONE 'UTC',
  t."count"
FROM "AccountClassificationFreshnessBucket" t
WHERE :scope
