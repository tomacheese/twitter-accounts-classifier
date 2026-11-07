-- finalize: 旧 text id (uuid、cuid) を int identity に変換する表を組み立てる。
--   AnalysisWorkItem (未処理・実行中・dead のみ)、AnalysisWorkItemDone (完了台帳)、AnalysisRun、LabelMetricSnapshot、
--   OverviewSnapshot、ReadModelGeneration、OperationStage
-- 新 id は決定的に採番する。
--   work item: 残す行を createdAt、旧 id の順に 1..K、台帳の行と、完了済みで参照だけが残る id を旧 id の順に K+1.. とする。
--   AnalysisRun: startedAt、旧 id の順に 1..N。
-- 外部キーは張らないため、参照だけが残る id の work item 本体は新 DB に存在しない。
-- 単一トランザクション (psql -1) で実行する。

TRUNCATE "AnalysisWorkItem", "AnalysisWorkItemDone", "AnalysisRun", "LabelMetricSnapshot", "OverviewSnapshot",
         "ReadModelGeneration", "OperationStage", mig.map_work_item, mig.map_run;

INSERT INTO mig.map_work_item (old_id, new_id)
SELECT w."id", row_number() OVER (ORDER BY w."createdAt", w."id" COLLATE "C")
FROM stg."AnalysisWorkItem" w;

INSERT INTO mig.map_work_item (old_id, new_id)
SELECT r."id",
       (SELECT count(*) FROM stg."AnalysisWorkItem") + row_number() OVER (ORDER BY r."id" COLLATE "C")
FROM (SELECT "id" FROM stg.work_item_ref UNION SELECT "workItemId" FROM stg."AnalysisWorkItemDone") r
WHERE NOT EXISTS (SELECT 1 FROM mig.map_work_item m WHERE m.old_id = r."id");

INSERT INTO mig.map_run (old_id, new_id)
SELECT a."id", row_number() OVER (ORDER BY a."startedAt", a."id" COLLATE "C")
FROM stg."AnalysisRun" a;

INSERT INTO "AnalysisWorkItemDone"
  ("completedAt", "createdAt", "workItemId", "attemptCount", "kind", "triggerType", "triggerId")
SELECT d."completedAt", d."createdAt", m.new_id, d."attemptCount", d."kind", d."triggerType", d."triggerId"
FROM stg."AnalysisWorkItemDone" d
JOIN mig.map_work_item m ON m.old_id = d."workItemId"
ORDER BY m.new_id;

-- AnalysisWorkItem と AnalysisRun は GENERATED ALWAYS の identity のため、OVERRIDING SYSTEM VALUE で id を入れる。
INSERT INTO "AnalysisWorkItem"
  ("availableAt", "leaseExpiresAt", "staleRequestedAt", "createdAt", "updatedAt", "id", "priority", "attemptCount",
   "maxAttempts", "kind", "triggerType", "triggerId", "status", "leaseOwner", "dependencyKey", "lastErrorCode", "lastErrorSummary")
OVERRIDING SYSTEM VALUE
SELECT w."availableAt", w."leaseExpiresAt", w."staleRequestedAt", w."createdAt", w."updatedAt", m.new_id, w."priority",
       w."attemptCount", w."maxAttempts", w."kind", w."triggerType", w."triggerId", w."status", w."leaseOwner",
       w."dependencyKey", w."lastErrorCode", w."lastErrorSummary"
FROM stg."AnalysisWorkItem" w
JOIN mig.map_work_item m ON m.old_id = w."id"
ORDER BY m.new_id;

INSERT INTO "AnalysisRun"
  ("startedAt", "finishedAt", "id", "workItemId", "attemptNumber", "status", "errorCode", "errorSummary")
OVERRIDING SYSTEM VALUE
SELECT a."startedAt", a."finishedAt", r.new_id, w.new_id, a."attemptNumber", a."status", a."errorCode", a."errorSummary"
FROM stg."AnalysisRun" a
JOIN mig.map_run r ON r.old_id = a."id"
LEFT JOIN mig.map_work_item w ON w.old_id = a."workItemId"
ORDER BY r.new_id;

-- 次に採番される id が、取り込んだ最大値 (台帳と参照だけが残る id を含む) の次になるようにする。
SELECT setval(pg_get_serial_sequence('"AnalysisWorkItem"', 'id'), GREATEST((SELECT max(new_id) FROM mig.map_work_item), 1), (SELECT count(*) > 0 FROM mig.map_work_item));
SELECT setval(pg_get_serial_sequence('"AnalysisRun"', 'id'), GREATEST((SELECT max(new_id) FROM mig.map_run), 1), (SELECT count(*) > 0 FROM mig.map_run));

INSERT INTO "LabelMetricSnapshot"
  ("id", "sourceCrawlRunId", "triggerWorkItemId", "labelDefinitionId", "observedAt", "generatedAt", "sourceWatermarkAt",
   "populationCount", "evaluatedCount", "trueCount", "prevalence", "coverage", "currentCount", "delayedCount", "staleCount",
   "unknownCount", "staleRatio", "trueConfidenceAverage", "falseConfidenceAverage", "confidenceBuckets",
   "reasonDistribution", "ruleVersionDistribution", "completeness", "policyHash", "analyzerVersion", "analysisRunId")
SELECT s."id", s."sourceCrawlRunId", w.new_id, s."labelDefinitionId", s."observedAt", s."generatedAt", s."sourceWatermarkAt",
       s."populationCount", s."evaluatedCount", s."trueCount", s."prevalence", s."coverage", s."currentCount", s."delayedCount",
       s."staleCount", s."unknownCount", s."staleRatio", s."trueConfidenceAverage", s."falseConfidenceAverage",
       s."confidenceBuckets", s."reasonDistribution", s."ruleVersionDistribution", s."completeness", s."policyHash",
       s."analyzerVersion", r.new_id
FROM stg."LabelMetricSnapshot" s
JOIN mig.map_work_item w ON w.old_id = s."triggerWorkItemId"
LEFT JOIN mig.map_run r ON r.old_id = s."analysisRunId";

INSERT INTO "OverviewSnapshot"
  ("id", "generationId", "schemaVersion", "generatedAt", "sourceWatermarkAt", "operationalStatus", "qualityStatus", "payload", "analysisRunId")
SELECT s."id", s."generationId", s."schemaVersion", s."generatedAt", s."sourceWatermarkAt", s."operationalStatus",
       s."qualityStatus", s."payload", r.new_id
FROM stg."OverviewSnapshot" s
LEFT JOIN mig.map_run r ON r.old_id = s."analysisRunId";

INSERT INTO "ReadModelGeneration"
  ("id", "modelKey", "schemaVersion", "status", "sourceWatermarkAt", "startedAt", "completedAt", "rowCount", "validationSummary", "analysisRunId")
SELECT s."id", s."modelKey", s."schemaVersion", s."status", s."sourceWatermarkAt", s."startedAt", s."completedAt",
       s."rowCount", s."validationSummary", r.new_id
FROM stg."ReadModelGeneration" s
LEFT JOIN mig.map_run r ON r.old_id = s."analysisRunId";

INSERT INTO "OperationStage"
  ("id", "cycleId", "stageKey", "sequence", "requiredness", "status", "attemptCount", "sourceType", "sourceId", "expectedAt",
   "delayedAt", "staleAt", "startedAt", "heartbeatAt", "finishedAt", "counters", "errorCode", "errorSummary", "analysisRunId")
SELECT s."id", s."cycleId", s."stageKey", s."sequence", s."requiredness", s."status", s."attemptCount", s."sourceType",
       s."sourceId", s."expectedAt", s."delayedAt", s."staleAt", s."startedAt", s."heartbeatAt", s."finishedAt",
       s."counters", s."errorCode", s."errorSummary", r.new_id
FROM stg."OperationStage" s
LEFT JOIN mig.map_run r ON r.old_id = s."analysisRunId";

-- 変換できなかった参照 (旧 id が変換表に無いもの) が残っていないことを確認する。
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM stg."AnalysisWorkItemDone" d
   WHERE NOT EXISTS (SELECT 1 FROM mig.map_work_item m WHERE m.old_id = d."workItemId");
  IF n <> 0 THEN RAISE EXCEPTION 'ASSERT_FAILED: % AnalysisWorkItemDone rows with unmapped workItemId', n; END IF;
  SELECT count(*) INTO n FROM stg."AnalysisRun" a
   WHERE a."workItemId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mig.map_work_item m WHERE m.old_id = a."workItemId");
  IF n <> 0 THEN RAISE EXCEPTION 'ASSERT_FAILED: % AnalysisRun rows with unmapped workItemId', n; END IF;
  SELECT count(*) INTO n FROM stg."LabelMetricSnapshot" s
   WHERE NOT EXISTS (SELECT 1 FROM mig.map_work_item m WHERE m.old_id = s."triggerWorkItemId");
  IF n <> 0 THEN RAISE EXCEPTION 'ASSERT_FAILED: % LabelMetricSnapshot rows with unmapped triggerWorkItemId', n; END IF;
  SELECT count(*) INTO n FROM (
    SELECT "analysisRunId" FROM stg."LabelMetricSnapshot" UNION ALL SELECT "analysisRunId" FROM stg."OverviewSnapshot"
    UNION ALL SELECT "analysisRunId" FROM stg."ReadModelGeneration" UNION ALL SELECT "analysisRunId" FROM stg."OperationStage"
  ) x WHERE x."analysisRunId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM mig.map_run m WHERE m.old_id = x."analysisRunId");
  IF n <> 0 THEN RAISE EXCEPTION 'ASSERT_FAILED: % rows with unmapped analysisRunId', n; END IF;
END
$$;
