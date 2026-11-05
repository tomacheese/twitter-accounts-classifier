-- target: "AccountClassificationConfidenceBucketCount"
-- columns: "labelDefinitionId", "confidenceBucket", "count"
-- scope: none
-- big: no
SELECT
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."confidenceBucket",
  t."count"
FROM "AccountClassificationConfidenceBucketCount" t
WHERE :scope
