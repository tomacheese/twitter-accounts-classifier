-- target: "ReadModelBootstrap"
-- columns: "modelKey", "status", "cursor", "processedCount", "startedAt", "updatedAt", "completedAt", "errorSummary"
-- scope: none
-- big: no
SELECT
  t."modelKey",
  t."status",
  t."cursor",
  t."processedCount",
  t."startedAt" AT TIME ZONE 'UTC',
  t."updatedAt" AT TIME ZONE 'UTC',
  t."completedAt" AT TIME ZONE 'UTC',
  t."errorSummary"
FROM "ReadModelBootstrap" t
WHERE :scope
