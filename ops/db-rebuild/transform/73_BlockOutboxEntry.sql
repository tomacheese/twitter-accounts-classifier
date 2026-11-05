-- target: "BlockOutboxEntry"
-- columns: "id", "blockAccountRunId", "blockerId", "blockedId", "labelDefinitionId", "confidence", "status", "remoteSkipCount", "lastRemoteSkippedAt", "createdAt", "remoteSucceededAt", "localPersistedAt", "reconciledAt"
-- scope: blockerId,blockedId
-- big: no
SELECT
  t."id",
  t."blockAccountRunId",
  t."blockerId"::bigint,
  t."blockedId"::bigint,
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."confidence",
  t."status",
  t."remoteSkipCount",
  t."lastRemoteSkippedAt" AT TIME ZONE 'UTC',
  t."createdAt" AT TIME ZONE 'UTC',
  t."remoteSucceededAt" AT TIME ZONE 'UTC',
  t."localPersistedAt" AT TIME ZONE 'UTC',
  t."reconciledAt" AT TIME ZONE 'UTC'
FROM "BlockOutboxEntry" t
WHERE :scope
