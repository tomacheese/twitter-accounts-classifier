-- target: "OperationCycle"
-- columns: "id", "kind", "sourceType", "sourceId", "triggeredAt", "expectedAt", "startedAt", "finishedAt", "status", "attentionRequired", "currentStageKey", "sourceWatermarkAt", "modelVersion", "updatedAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."kind",
  t."sourceType",
  t."sourceId",
  t."triggeredAt" AT TIME ZONE 'UTC',
  t."expectedAt" AT TIME ZONE 'UTC',
  t."startedAt" AT TIME ZONE 'UTC',
  t."finishedAt" AT TIME ZONE 'UTC',
  t."status",
  t."attentionRequired",
  t."currentStageKey",
  t."sourceWatermarkAt" AT TIME ZONE 'UTC',
  t."modelVersion",
  t."updatedAt" AT TIME ZONE 'UTC'
FROM "OperationCycle" t
WHERE :scope
