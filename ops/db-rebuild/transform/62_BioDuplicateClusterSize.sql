-- target: "BioDuplicateClusterSize"
-- columns: "clusterKey", "size", "memberIds"
-- scope: none
-- big: no
SELECT
  t."clusterKey",
  t."size",
  t."memberIds"::bigint[]
FROM "BioDuplicateClusterSize" t
WHERE :scope
