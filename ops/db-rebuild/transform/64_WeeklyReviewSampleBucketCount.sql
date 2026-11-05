-- target: "WeeklyReviewSampleBucketCount"
-- columns: "labelDefinitionId", "value", "bucket", "count"
-- scope: none
-- big: no
SELECT
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."value",
  t."bucket",
  t."count"
FROM "WeeklyReviewSampleBucketCount" t
WHERE :scope
