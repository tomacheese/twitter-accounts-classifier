-- target: "DetectorEvaluation"
-- columns: "id", "detectorType", "fingerprint", "identityVersion", "sourceId", "evaluatedAt", "isShadow", "result", "policyHash"
-- scope: none
-- big: no
SELECT
  t."id",
  t."detectorType",
  t."fingerprint",
  t."identityVersion",
  t."sourceId",
  t."evaluatedAt" AT TIME ZONE 'UTC',
  t."isShadow",
  t."result",
  t."policyHash"
FROM "DetectorEvaluation" t
WHERE :scope
