-- target: "LabelMetricDaily"
-- columns: "id", "date", "labelDefinitionId", "evaluatedCount", "trueCount", "prevalence", "confidenceBuckets", "reasonDistribution", "sourceObservedAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."date",
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."evaluatedCount",
  t."trueCount",
  t."prevalence",
  t."confidenceBuckets",
  t."reasonDistribution",
  t."sourceObservedAt" AT TIME ZONE 'UTC'
FROM "LabelMetricDaily" t
WHERE :scope
