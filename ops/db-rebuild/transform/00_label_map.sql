-- prepare: 旧 LabelDefinition.id (cuid) から新 smallint id への変換表を作る。
-- 出力は (old_id, new_id, key, description, createdAt, currentRuleVersion, placeholder) の text 形式。
-- 新 id は (定義の有無, createdAt, key の C 照合順) で決定的に採番する。
-- LabelDefinition に定義が無いのに参照だけが残っている id (廃止済みラベルの AccountLabelChange など) も採番し、
-- placeholder = true のプレースホルダー行として保持する。参照元は、定義が確実に残る巨大表 (AccountLabelLatest、
-- AccountClassificationLatest) を除く。巨大表側で未登録の id が出た場合は、NOT NULL 違反で投入が止まる。
-- target: mig.label_map
-- columns: old_id, new_id, key, description, created_at, current_rule_version, placeholder
-- scope: none
-- big: no
-- format: text
WITH defs AS (
  SELECT d.id AS old_id, d.key, d.description, d."createdAt", d."currentRuleVersion", false AS placeholder
  FROM "LabelDefinition" d
), refs AS (
  SELECT "labelDefinitionId" AS id FROM "AccountLabelChange" GROUP BY 1
  UNION SELECT "labelDefinitionId" FROM "BlockAction"
  UNION SELECT "labelDefinitionId" FROM "BlockOutboxEntry"
  UNION SELECT "labelDefinitionId" FROM "CrawlAccountLabelRun"
  UNION SELECT "labelDefinitionId" FROM "LabelMetricSnapshot"
  UNION SELECT "labelDefinitionId" FROM "LabelMetricDaily"
  UNION SELECT "labelDefinitionId" FROM "LabelSummaryCurrent"
  UNION SELECT "labelDefinitionId" FROM "WeeklyReviewSampleBucketCount"
  UNION SELECT "labelDefinitionId" FROM "AccountClassificationValueCount"
  UNION SELECT "labelDefinitionId" FROM "AccountClassificationRuleVersionCount"
  UNION SELECT "labelDefinitionId" FROM "AccountClassificationConfidenceBucketCount"
  UNION SELECT "labelDefinitionId" FROM "AccountClassificationReasonCount"
  UNION SELECT "labelDefinitionId" FROM "AccountClassificationFreshnessBucket"
), orphans AS (
  SELECT r.id AS old_id, 'retired:' || r.id AS key,
         'placeholder for a label id that has no LabelDefinition row' AS description,
         NULL::timestamp AS "createdAt", NULL::text AS "currentRuleVersion", true AS placeholder
  FROM refs r
  WHERE NOT EXISTS (SELECT 1 FROM defs d WHERE d.old_id = r.id)
), all_labels AS (
  SELECT * FROM defs UNION ALL SELECT * FROM orphans
)
SELECT old_id,
       row_number() OVER (ORDER BY placeholder, "createdAt", key COLLATE "C", old_id COLLATE "C"),
       key, description, to_char("createdAt", 'YYYY-MM-DD HH24:MI:SS.MS'), "currentRuleVersion", placeholder
FROM all_labels
ORDER BY 2
