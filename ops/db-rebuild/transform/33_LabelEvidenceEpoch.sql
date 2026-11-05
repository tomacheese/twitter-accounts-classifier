-- target: "LabelEvidenceEpoch"
-- columns: "id", "crawlRunId", "sourceWatermarkAt", "createdAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."crawlRunId",
  t."sourceWatermarkAt" AT TIME ZONE 'UTC',
  t."createdAt" AT TIME ZONE 'UTC'
FROM "LabelEvidenceEpoch" t
WHERE :scope
