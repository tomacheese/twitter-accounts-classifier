-- target: "BlockAction"
-- columns: "id", "blockAccountRunId", "blockerId", "blockedId", "labelDefinitionId", "confidence", "result", "errorMessage", "createdAt", "outboxEntryId"
-- scope: blockerId,blockedId
-- big: no
SELECT
  t."id",
  t."blockAccountRunId",
  t."blockerId"::bigint,
  t."blockedId"::bigint,
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."confidence",
  t."result",
  t."errorMessage",
  t."createdAt" AT TIME ZONE 'UTC',
  t."outboxEntryId"
FROM "BlockAction" t
WHERE :scope
