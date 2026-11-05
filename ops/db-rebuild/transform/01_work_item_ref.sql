-- stage: AnalysisRun.workItemId と LabelMetricSnapshot.triggerWorkItemId が参照する旧 work item id。
-- 完了済みの AnalysisWorkItem 本体は持ち込まないため、参照だけが残る id にも新しい int id を与える (外部キーなし)。
-- target: stg.work_item_ref
-- columns: "id"
-- scope: none
-- big: no
SELECT "workItemId" FROM "AnalysisRun" WHERE "workItemId" IS NOT NULL
UNION
SELECT "triggerWorkItemId" FROM "LabelMetricSnapshot"
