-- target: "StorageCapacityState"
-- columns: "id", "availableGib", "usedPercent", "measuredAt", "relabelBlocked", "updatedAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."availableGib",
  t."usedPercent",
  t."measuredAt" AT TIME ZONE 'UTC',
  t."relabelBlocked",
  t."updatedAt" AT TIME ZONE 'UTC'
FROM "StorageCapacityState" t
WHERE :scope
