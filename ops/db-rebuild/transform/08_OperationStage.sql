-- stage: OperationStage。analysisRunId は旧 text のまま stg に入れ、finalize で int id に変換する。
-- target: stg."OperationStage"
-- columns: "id", "cycleId", "stageKey", "sequence", "requiredness", "status", "attemptCount", "sourceType", "sourceId", "expectedAt", "delayedAt", "staleAt", "startedAt", "heartbeatAt", "finishedAt", "counters", "errorCode", "errorSummary", "analysisRunId"
-- scope: none
-- big: no
SELECT t."id", t."cycleId", t."stageKey", t."sequence", t."requiredness", t."status", t."attemptCount",
  t."sourceType", t."sourceId",
  t."expectedAt" AT TIME ZONE 'UTC', t."delayedAt" AT TIME ZONE 'UTC', t."staleAt" AT TIME ZONE 'UTC',
  t."startedAt" AT TIME ZONE 'UTC', t."heartbeatAt" AT TIME ZONE 'UTC', t."finishedAt" AT TIME ZONE 'UTC',
  t."counters", t."errorCode", t."errorSummary", t."analysisRunId"
FROM "OperationStage" t
