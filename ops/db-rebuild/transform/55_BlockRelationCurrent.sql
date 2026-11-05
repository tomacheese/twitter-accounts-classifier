-- target: "BlockRelationCurrent"
-- columns: "generationId", "blockId", "normalizedBlockerScreenName", "normalizedBlockedScreenName", "status", "statusChangedAt", "activeFindingCount", "highestFindingSeverity", "sourceWatermarkAt"
-- scope: none
-- big: no
SELECT
  t."generationId",
  t."blockId",
  t."normalizedBlockerScreenName",
  t."normalizedBlockedScreenName",
  t."status",
  t."statusChangedAt" AT TIME ZONE 'UTC',
  t."activeFindingCount",
  t."highestFindingSeverity",
  t."sourceWatermarkAt" AT TIME ZONE 'UTC'
FROM "BlockRelationCurrent" t
WHERE :scope
