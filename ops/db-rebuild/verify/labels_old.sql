-- scope: accountId
-- big: ctid
-- from: AccountLabelLatest
-- 検証 (旧 DB 側): 旧 AccountLabelLatest を 1 回の走査で集計する。
-- 出力は (kind, shard, label_key, rule_version, value, evaluable, n, h_sample, h_all) の text 形式。
--   kind = 'S': hashtext(accountId) % 256 のシャードごとの件数と内容ハッシュ
--     h_sample: 新側の AccountLabelState と AccountActiveLabel から再構築できる項目だけのハッシュ。
--               false 行と評価不能行の reason、confidence などは含めない。sample_mod で標本のアカウントに絞る
--     h_all:    labeledAt を含む全行のハッシュ (新側の stg.label_row と比べる転送の確認用)
--   kind = 'G': ラベル × ruleVersion × value × evaluable ごとの件数 (true 件数、評価不能件数、coverage の元)
-- 変数: scope (旧 AccountLabelLatest の別名 t への絞り込み)、sample_mod (整数)
SELECT CASE WHEN GROUPING(x.shard) = 0 THEN 'S' ELSE 'G' END AS kind,
       x.shard, x.lkey, x.rv, x.value, x.evaluable,
       count(*) AS n,
       sum(x.h_sample) FILTER (WHERE x.is_sample) AS h_sample,
       sum(x.h_all) AS h_all
FROM (
  SELECT hashtext(t."accountId") % 256 AS shard,
         d.key AS lkey,
         t."ruleVersion" AS rv,
         (t."value" AND t."evaluable") AS value,
         t."evaluable" AS evaluable,
         (hashtext(t."accountId") % :sample_mod) = 0 AS is_sample,
         hashtextextended(concat_ws('|', t."accountId", d.key, t."ruleVersion", (t."value" AND t."evaluable")::text, t."evaluable"::text,
           CASE WHEN t."value" AND t."evaluable" THEN concat_ws('|', t."confidence"::text, t."reason", t."method",
             to_char(t."labeledAt", 'YYYY-MM-DD HH24:MI:SS.MS'),
             (CASE t."sourceKind" WHEN 'legacy' THEN 0 WHEN 'crawl' THEN 1 ELSE 2 END)::text,
             COALESCE(t."sourceId", '<null>'), COALESCE(t."sourceUsername", '<null>')) END), 0)::numeric AS h_sample,
         hashtextextended(concat_ws('|', t."accountId", d.key, t."ruleVersion", (t."value" AND t."evaluable")::text, t."evaluable"::text,
           to_char(t."labeledAt", 'YYYY-MM-DD HH24:MI:SS.MS')), 0)::numeric AS h_all
  FROM "AccountLabelLatest" t
  JOIN "LabelDefinition" d ON d."id" = t."labelDefinitionId"
  WHERE :scope
) x
GROUP BY GROUPING SETS ((x.shard), (x.lkey, x.rv, x.value, x.evaluable))
