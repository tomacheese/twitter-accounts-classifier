-- AccountClassificationObservation。classificationSnapshot (JSON、約 1.5GB) は、まだ処理待ちの
-- account_summary_refresh が参照する観測だけに残し、それ以外は NULL にする。
-- 処理待ちの判定は AnalysisWorkItem.status が succeeded 以外 (インデックスを使うため `<` と `>` の和で書く)。
-- target: "AccountClassificationObservation"
-- columns: "observedAt", "createdAt", "accountId", "labelCount", "snapshotVersion", "id", "crawlRunId", "username", "classificationSnapshot"
-- scope: accountId
-- big: no
WITH pending AS MATERIALIZED (
  SELECT "triggerId" FROM "AnalysisWorkItem"
  WHERE "triggerType" = 'account_classification_observation'
    AND ("status" < 'succeeded' OR "status" > 'succeeded')
)
SELECT
  t."observedAt" AT TIME ZONE 'UTC',
  t."createdAt" AT TIME ZONE 'UTC',
  t."accountId"::bigint,
  t."labelCount",
  t."snapshotVersion",
  t."id",
  t."crawlRunId",
  t."username",
  CASE WHEN t."id" IN (SELECT "triggerId" FROM pending) THEN t."classificationSnapshot" END
FROM "AccountClassificationObservation" t
WHERE :scope
