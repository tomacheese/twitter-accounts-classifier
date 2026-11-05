-- target: "LabelSummaryCurrent"
-- columns: "generationId", "labelDefinitionId", "latestSnapshotId", "evaluatedCount", "trueCount", "populationCount", "coverage", "prevalence", "previousRunDelta", "dayDelta", "weekDelta", "confidenceShift", "reasonShift", "activeFindingCount", "highestFindingSeverity", "qualityStatus", "sourceWatermarkAt", "updatedAt"
-- scope: none
-- big: no
SELECT
  t."generationId",
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."latestSnapshotId",
  t."evaluatedCount",
  t."trueCount",
  t."populationCount",
  t."coverage",
  t."prevalence",
  t."previousRunDelta",
  t."dayDelta",
  t."weekDelta",
  t."confidenceShift",
  t."reasonShift",
  t."activeFindingCount",
  t."highestFindingSeverity",
  t."qualityStatus",
  t."sourceWatermarkAt" AT TIME ZONE 'UTC',
  t."updatedAt" AT TIME ZONE 'UTC'
FROM "LabelSummaryCurrent" t
WHERE :scope
