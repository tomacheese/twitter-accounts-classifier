-- target: "RelabelScanCursor"
-- columns: "id", "lastScannedAccountId", "updatedAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."lastScannedAccountId"::bigint,
  t."updatedAt" AT TIME ZONE 'UTC'
FROM "RelabelScanCursor" t
WHERE :scope
