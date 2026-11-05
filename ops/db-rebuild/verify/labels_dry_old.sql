-- scope: accountId
-- big: no
-- batch: all
-- from: AccountLabelLatest
-- 検証 (旧 DB 側): 乾式の差分用に、標本アカウントの (アカウント, ラベル) ごとの行ハッシュを返す。
-- 変数: scope。labels_new.sql の乾式の差分の節が、新側の再構築と突き合わせる。
SELECT t."accountId"::bigint, d.key,
       hashtextextended(concat_ws('|', t."accountId", d.key, t."ruleVersion", (t."value" AND t."evaluable")::text, t."evaluable"::text,
         CASE WHEN t."value" AND t."evaluable" THEN concat_ws('|', t."confidence"::text, t."reason", t."method",
           to_char(t."labeledAt", 'YYYY-MM-DD HH24:MI:SS.MS'),
           (CASE t."sourceKind" WHEN 'legacy' THEN 0 WHEN 'crawl' THEN 1 ELSE 2 END)::text,
           COALESCE(t."sourceId", '<null>'), COALESCE(t."sourceUsername", '<null>')) END), 0)
FROM "AccountLabelLatest" t
JOIN "LabelDefinition" d ON d."id" = t."labelDefinitionId"
WHERE :scope
