-- target: "Follow"
-- columns: "id", "followerId", "followeeId", "firstSeenAt", "lastSeenAt"
-- scope: followerId,followeeId
-- big: no
SELECT
  t."id",
  t."followerId"::bigint,
  t."followeeId"::bigint,
  t."firstSeenAt" AT TIME ZONE 'UTC',
  t."lastSeenAt" AT TIME ZONE 'UTC'
FROM "Follow" t
WHERE :scope
