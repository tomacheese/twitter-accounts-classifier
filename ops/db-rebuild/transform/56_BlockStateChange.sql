-- target: "BlockStateChange"
-- columns: "id", "blockId", "fromStatus", "toStatus", "changedAt", "sourceId"
-- scope: none
-- big: no
SELECT
  t."id",
  t."blockId",
  t."fromStatus",
  t."toStatus",
  t."changedAt" AT TIME ZONE 'UTC',
  t."sourceId"
FROM "BlockStateChange" t
WHERE :scope
