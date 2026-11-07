-- AccountLabelChange。id は新しい int identity が採番する (列リストに入れない)。
-- 追記のみの表で BRIN(changedAt) が効くよう、changedAt 順に流して物理順を時刻順にする。
-- sourceLabelId は旧スキーマでは削除済みの列で、全行 NULL になる。
-- 旧データには changeType = 'updated' (値が変わらない confidence や reason の更新) の行が多い。
-- 新 baseline の enum AccountLabelChangeType は 'added'、'removed'、'unevaluable' で、'updated' を持たない。
-- keep_updated = true なら 'updated' の行も流す (新側の enum に 'updated' があることが前提)。
-- false なら 'updated' の行を捨てる。どちらを採るかは、ユーザーの判断が必要。
-- target: "AccountLabelChange"
-- columns: "accountId", "changedAt", "previousConfidence", "newConfidence", "changeType", "labelDefinitionId", "previousValue", "newValue", "sourceId", "previousReason", "newReason"
-- scope: accountId
-- big: no
-- batch: all
SELECT
  t."accountId"::bigint,
  t."changedAt" AT TIME ZONE 'UTC',
  t."previousConfidence",
  t."newConfidence",
  t."changeType",
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."previousValue",
  t."newValue",
  t."sourceId",
  t."previousReason",
  t."newReason"
FROM "AccountLabelChange" t
WHERE :scope
  AND (:keep_updated OR t."changeType" <> 'updated')
ORDER BY t."changedAt", t."id"
