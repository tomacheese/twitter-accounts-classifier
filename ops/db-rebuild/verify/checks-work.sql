-- 検証 (新 DB 側): AnalysisWorkItem と、旧 text id を int id に変換した表の整合。
-- stg の表は、旧 DB の行をそのまま (id だけ text で) 持っている (verify.sh が旧 DB との一致を別に確認する)。
-- 出力は 1 行 1 ゲートの「ゲート名|PASS or FAIL|詳細」。
SET TimeZone = 'UTC';

SELECT 'work: ' || t.tbl || ' row count = staged old rows',
       CASE WHEN t.a = t.b THEN 'PASS' ELSE 'FAIL' END, 'final=' || t.a || ' staged=' || t.b
FROM (
  SELECT 'AnalysisWorkItem' AS tbl, (SELECT count(*) FROM "AnalysisWorkItem") AS a, (SELECT count(*) FROM stg."AnalysisWorkItem") AS b
  UNION ALL SELECT 'AnalysisWorkItemDone', (SELECT count(*) FROM "AnalysisWorkItemDone"), (SELECT count(*) FROM stg."AnalysisWorkItemDone")
  UNION ALL SELECT 'AnalysisRun', (SELECT count(*) FROM "AnalysisRun"), (SELECT count(*) FROM stg."AnalysisRun")
  UNION ALL SELECT 'LabelMetricSnapshot', (SELECT count(*) FROM "LabelMetricSnapshot"), (SELECT count(*) FROM stg."LabelMetricSnapshot")
  UNION ALL SELECT 'OverviewSnapshot', (SELECT count(*) FROM "OverviewSnapshot"), (SELECT count(*) FROM stg."OverviewSnapshot")
  UNION ALL SELECT 'ReadModelGeneration', (SELECT count(*) FROM "ReadModelGeneration"), (SELECT count(*) FROM stg."ReadModelGeneration")
  UNION ALL SELECT 'OperationStage', (SELECT count(*) FROM "OperationStage"), (SELECT count(*) FROM stg."OperationStage")
) t;

-- 参照の有無 (NULL かどうか) が変換の前後で変わっていない。
SELECT 'work: AnalysisRun.workItemId null-ness preserved',
       CASE WHEN a = b THEN 'PASS' ELSE 'FAIL' END, 'final null=' || a || ' staged null=' || b
FROM (SELECT (SELECT count(*) FROM "AnalysisRun" WHERE "workItemId" IS NULL) AS a,
             (SELECT count(*) FROM stg."AnalysisRun" WHERE "workItemId" IS NULL) AS b) x;

SELECT 'work: analysisRunId null-ness preserved (LabelMetricSnapshot, OverviewSnapshot, ReadModelGeneration, OperationStage)',
       CASE WHEN a = b THEN 'PASS' ELSE 'FAIL' END, 'final null=' || a || ' staged null=' || b
FROM (SELECT (SELECT count(*) FROM "LabelMetricSnapshot" WHERE "analysisRunId" IS NULL) + (SELECT count(*) FROM "OverviewSnapshot" WHERE "analysisRunId" IS NULL)
             + (SELECT count(*) FROM "ReadModelGeneration" WHERE "analysisRunId" IS NULL) + (SELECT count(*) FROM "OperationStage" WHERE "analysisRunId" IS NULL) AS a,
             (SELECT count(*) FROM stg."LabelMetricSnapshot" WHERE "analysisRunId" IS NULL) + (SELECT count(*) FROM stg."OverviewSnapshot" WHERE "analysisRunId" IS NULL)
             + (SELECT count(*) FROM stg."ReadModelGeneration" WHERE "analysisRunId" IS NULL) + (SELECT count(*) FROM stg."OperationStage" WHERE "analysisRunId" IS NULL) AS b) x;

-- 同じ旧 id から同じ新 id への変換が、参照する全表で一貫している (AnalysisRun.workItemId と LabelMetricSnapshot.triggerWorkItemId)。
SELECT 'work: work item id mapping is consistent across AnalysisRun and LabelMetricSnapshot',
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END, n || ' references differ'
FROM (SELECT count(*) AS n FROM stg."AnalysisRun" s
      JOIN "AnalysisRun" f ON f."id" = (SELECT new_id FROM mig.map_run WHERE old_id = s."id")
      WHERE s."workItemId" IS NOT NULL AND f."workItemId" IS DISTINCT FROM (SELECT new_id FROM mig.map_work_item WHERE old_id = s."workItemId")) x;

-- 残した work item は、未処理・実行中・dead だけである。
SELECT 'work: AnalysisWorkItem keeps only non-succeeded rows',
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END, n || ' succeeded rows'
FROM (SELECT count(*) AS n FROM "AnalysisWorkItem" WHERE "status" = 'succeeded') x;

-- 完了台帳 (AnalysisWorkItemDone): 旧 DB の完了済みの行を、論理キーごとに workItemId (変換表を通した新 id)、attemptCount、
-- createdAt、completedAt も含めて取りこぼさず、余計な行も持たない。
SELECT 'work: AnalysisWorkItemDone carries workItemId, attemptCount, createdAt and completedAt of the old succeeded rows',
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END, n || ' rows differ or are missing'
FROM (SELECT count(*) AS n FROM stg."AnalysisWorkItemDone" s
      LEFT JOIN mig.map_work_item m ON m.old_id = s."workItemId"
      LEFT JOIN "AnalysisWorkItemDone" d ON (d."kind", d."triggerType", d."triggerId") = (s."kind", s."triggerType", s."triggerId")
      WHERE d."kind" IS NULL OR m.new_id IS NULL OR d."workItemId" IS DISTINCT FROM m.new_id
         OR d."attemptCount" IS DISTINCT FROM s."attemptCount" OR d."createdAt" IS DISTINCT FROM s."createdAt"
         OR d."completedAt" IS DISTINCT FROM s."completedAt") x;

SELECT 'work: AnalysisWorkItemDone has no account_relabel (re-armable) rows',
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END, n || ' rows'
FROM (SELECT count(*) AS n FROM "AnalysisWorkItemDone" WHERE "kind" = 'account_relabel') x;

-- 台帳とキュー表で、論理キーも workItemId も重ならない (同じ論理キーが完了済みと未処理の両方にならない)。
SELECT 'work: AnalysisWorkItemDone and AnalysisWorkItem share no logical key and no workItemId',
       CASE WHEN a = 0 AND b = 0 THEN 'PASS' ELSE 'FAIL' END, a || ' shared logical keys, ' || b || ' shared ids'
FROM (SELECT (SELECT count(*) FROM "AnalysisWorkItemDone" d JOIN "AnalysisWorkItem" w
                ON (w."kind", w."triggerType", w."triggerId") = (d."kind", d."triggerType", d."triggerId")) AS a,
             (SELECT count(*) FROM "AnalysisWorkItemDone" d JOIN "AnalysisWorkItem" w ON w."id" = d."workItemId") AS b) x;

-- 識別子の次の採番値が、取り込んだ最大値 (キュー表、台帳、参照だけが残る id の変換表) より大きい。
-- pg_sequences.last_value は nextval を消費せずに読める。setval(max, true) の直後は last_value が最大値と等しい。
SELECT 'work: AnalysisWorkItem identity is set beyond every imported work item id',
       CASE WHEN a >= b THEN 'PASS' ELSE 'FAIL' END, 'sequence last_value=' || a || ' max imported id=' || b
FROM (SELECT COALESCE((SELECT last_value FROM pg_sequences WHERE sequencename = 'AnalysisWorkItem_id_seq'), 0) AS a,
             GREATEST((SELECT COALESCE(max(id), 0) FROM "AnalysisWorkItem"), (SELECT COALESCE(max("workItemId"), 0) FROM "AnalysisWorkItemDone"),
                      (SELECT COALESCE(max(new_id), 0) FROM mig.map_work_item)) AS b) x;

SELECT 'work: AnalysisRun and AccountLabelChange identities are set beyond the imported ids',
       CASE WHEN a >= b AND c >= d THEN 'PASS' ELSE 'FAIL' END,
       'AnalysisRun last_value=' || a || ' max=' || b || '; AccountLabelChange last_value=' || c || ' max=' || d
FROM (SELECT COALESCE((SELECT last_value FROM pg_sequences WHERE sequencename = 'AnalysisRun_id_seq'), 0) AS a,
             (SELECT COALESCE(max(id), 0) FROM "AnalysisRun") AS b,
             COALESCE((SELECT last_value FROM pg_sequences WHERE sequencename = 'AccountLabelChange_id_seq'), 0) AS c,
             (SELECT COALESCE(max(id), 0) FROM "AccountLabelChange") AS d) x;

-- LabeledAccountCounter は、AccountSummaryLatest の activeLabelCount > 0 の件数とも整合する (旧 DB の値のままか、差を報告する)。
SELECT 'info: LabeledAccountCounter vs count(AccountSummaryLatest.activeLabelCount > 0)', 'INFO',
       'counter=' || (SELECT "labeledAccounts" FROM "LabeledAccountCounter" WHERE "id" = 'global')
       || ' recount=' || (SELECT count(*) FROM "AccountSummaryLatest" WHERE "activeLabelCount" > 0);
