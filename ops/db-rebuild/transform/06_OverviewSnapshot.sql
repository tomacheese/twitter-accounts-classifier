-- stage: OverviewSnapshot。analysisRunId は旧 text のまま stg に入れ、finalize で int id に変換する。
-- target: stg."OverviewSnapshot"
-- columns: "id", "generationId", "schemaVersion", "generatedAt", "sourceWatermarkAt", "operationalStatus", "qualityStatus", "payload", "analysisRunId"
-- scope: none
-- big: no
SELECT t."id", t."generationId", t."schemaVersion",
  t."generatedAt" AT TIME ZONE 'UTC', t."sourceWatermarkAt" AT TIME ZONE 'UTC',
  t."operationalStatus", t."qualityStatus", t."payload", t."analysisRunId"
FROM "OverviewSnapshot" t
