-- stage: LabelMetricSnapshot。triggerWorkItemId と analysisRunId は旧 text のまま stg に入れ、finalize で int id に変換する。
-- target: stg."LabelMetricSnapshot"
-- columns: "id", "sourceCrawlRunId", "triggerWorkItemId", "labelDefinitionId", "observedAt", "generatedAt", "sourceWatermarkAt", "populationCount", "evaluatedCount", "trueCount", "prevalence", "coverage", "currentCount", "delayedCount", "staleCount", "unknownCount", "staleRatio", "trueConfidenceAverage", "falseConfidenceAverage", "confidenceBuckets", "reasonDistribution", "ruleVersionDistribution", "completeness", "policyHash", "analyzerVersion", "analysisRunId"
-- scope: none
-- big: no
SELECT t."id", t."sourceCrawlRunId", t."triggerWorkItemId",
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."observedAt" AT TIME ZONE 'UTC', t."generatedAt" AT TIME ZONE 'UTC', t."sourceWatermarkAt" AT TIME ZONE 'UTC',
  t."populationCount", t."evaluatedCount", t."trueCount", t."prevalence", t."coverage",
  t."currentCount", t."delayedCount", t."staleCount", t."unknownCount", t."staleRatio",
  t."trueConfidenceAverage", t."falseConfidenceAverage",
  t."confidenceBuckets", t."reasonDistribution", t."ruleVersionDistribution",
  t."completeness", t."policyHash", t."analyzerVersion", t."analysisRunId"
FROM "LabelMetricSnapshot" t
