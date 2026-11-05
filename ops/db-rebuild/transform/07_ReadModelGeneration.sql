-- stage: ReadModelGeneration。analysisRunId は旧 text のまま stg に入れ、finalize で int id に変換する。
-- target: stg."ReadModelGeneration"
-- columns: "id", "modelKey", "schemaVersion", "status", "sourceWatermarkAt", "startedAt", "completedAt", "rowCount", "validationSummary", "analysisRunId"
-- scope: none
-- big: no
SELECT t."id", t."modelKey", t."schemaVersion", t."status",
  t."sourceWatermarkAt" AT TIME ZONE 'UTC', t."startedAt" AT TIME ZONE 'UTC', t."completedAt" AT TIME ZONE 'UTC',
  t."rowCount", t."validationSummary", t."analysisRunId"
FROM "ReadModelGeneration" t
