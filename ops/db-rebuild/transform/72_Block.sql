-- target: "Block"
-- columns: "id", "blockerId", "blockedId", "firstSeenAt", "lastSeenAt", "status", "lastCheckedAt", "missingSinceAt", "resolvedAt", "consecutiveMissingCount", "sourceKind", "sourceId"
-- scope: blockerId,blockedId
-- big: no
SELECT
  t."id",
  t."blockerId"::bigint,
  t."blockedId"::bigint,
  t."firstSeenAt" AT TIME ZONE 'UTC',
  t."lastSeenAt" AT TIME ZONE 'UTC',
  t."status",
  t."lastCheckedAt" AT TIME ZONE 'UTC',
  t."missingSinceAt" AT TIME ZONE 'UTC',
  t."resolvedAt" AT TIME ZONE 'UTC',
  t."consecutiveMissingCount",
  t."sourceKind",
  t."sourceId"
FROM "Block" t
WHERE :scope
