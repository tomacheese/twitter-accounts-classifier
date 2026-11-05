-- target: "PolicyBacktestFinding"
-- columns: "id", "runId", "fingerprint", "severity", "diffKind", "detail"
-- scope: none
-- big: no
SELECT
  t."id",
  t."runId",
  t."fingerprint",
  t."severity",
  t."diffKind",
  t."detail"
FROM "PolicyBacktestFinding" t
WHERE :scope
