-- stage: AnalysisRun。id と workItemId は旧 text のまま stg に入れ、finalize で int id に変換する。
-- target: stg."AnalysisRun"
-- columns: "id", "workItemId", "attemptNumber", "startedAt", "finishedAt", "status", "errorCode", "errorSummary"
-- scope: none
-- big: no
SELECT t."id", t."workItemId", t."attemptNumber",
  t."startedAt" AT TIME ZONE 'UTC', t."finishedAt" AT TIME ZONE 'UTC',
  t."status", t."errorCode", t."errorSummary"
FROM "AnalysisRun" t
