-- stage: 旧 AccountLabelLatest を、(アカウント, ラベル) の行のまま新側の stg.label_row へ流す。
-- AccountLabelState と AccountActiveLabel は、stg の全行が揃ってから finalize が組み立てる。
-- 新側に持ち込まない値は、ここで NULL にして転送量を減らす。
--   - value = false の行の reason、confidence、method、sourceKind、sourceId、sourceUsername (S+ で消える)
--   - 評価不能 (evaluable = false) の行も同様に消える
-- labeledAt は AccountLabelState.evaluatedAt (アカウントごとの最大値) を求めるため、全行で残す。
-- evaluable = false かつ value = true の行は、設計上存在しない。存在した場合は整数への変換エラーで
-- 投入を止める (エラーメッセージに ASSERT_FAILED が出る)。定数のままだと実行計画の段階で評価されるため、列を連結して式を非定数にしている。
-- 旧 sourceKind は 'legacy' = 0、'crawl' = 1、'relabel' = 2。それ以外は変換エラーで止める。
-- target: stg.label_row
-- columns: "accountId", "lid", "value", "evaluable", "labeledAt", "confidence", "ruleVersion", "sourceKind", "method", "reason", "sourceId", "sourceUsername"
-- scope: accountId
-- from: AccountLabelLatest
-- big: ctid
SELECT
  t."accountId"::bigint,
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  CASE WHEN NOT t."evaluable" AND t."value"
       THEN (t."accountId" || ' ASSERT_FAILED: evaluable=false and value=true')::int = 1
       ELSE t."value" END,
  t."evaluable",
  t."labeledAt" AT TIME ZONE 'UTC',
  CASE WHEN t."value" THEN t."confidence" END,
  t."ruleVersion",
  CASE WHEN t."value" THEN (CASE t."sourceKind"
         WHEN 'legacy' THEN 0 WHEN 'crawl' THEN 1 WHEN 'relabel' THEN 2
         ELSE ('ASSERT_FAILED: unknown sourceKind ' || t."sourceKind")::int END)::smallint END,
  CASE WHEN t."value" THEN t."method" END,
  CASE WHEN t."value" THEN t."reason" END,
  CASE WHEN t."value" THEN t."sourceId" END,
  CASE WHEN t."value" THEN t."sourceUsername" END
FROM "AccountLabelLatest" t
WHERE :scope
