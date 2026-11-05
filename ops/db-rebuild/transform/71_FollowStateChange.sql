-- target: "FollowStateChange"
-- columns: "id", "followerId", "followeeId", "changeType", "observedAt"
-- scope: followerId,followeeId
-- big: no
SELECT
  t."id",
  t."followerId"::bigint,
  t."followeeId"::bigint,
  t."changeType",
  t."observedAt" AT TIME ZONE 'UTC'
FROM "FollowStateChange" t
WHERE :scope
