-- target: "DetectionPolicyVersion"
-- columns: "id", "policyVersion", "contentHash", "schemaVersion", "content", "loadedAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."policyVersion",
  t."contentHash",
  t."schemaVersion",
  t."content",
  t."loadedAt" AT TIME ZONE 'UTC'
FROM "DetectionPolicyVersion" t
WHERE :scope
