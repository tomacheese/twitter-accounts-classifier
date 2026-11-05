-- parity-acl.sql の実行後に、集計表を型に依存しない文字列で並べて出力する。
-- observedAtBucket は旧が timestamp、新が timestamptz のため、末尾の +00 を落として比べる。
\pset format unaligned
\pset tuples_only on
SELECT 'value|' || "labelDefinitionId" || '|' || "value" || '|' || "count" || '|' || round("confidenceSum"::numeric, 6)
  FROM "AccountClassificationValueCount" WHERE "count" <> 0 ORDER BY 1;
SELECT 'confidence|' || "labelDefinitionId" || '|' || "confidenceBucket" || '|' || "count"
  FROM "AccountClassificationConfidenceBucketCount" WHERE "count" <> 0 ORDER BY 1;
SELECT 'rule|' || "labelDefinitionId" || '|' || "ruleVersion" || '|' || "count"
  FROM "AccountClassificationRuleVersionCount" WHERE "count" <> 0 ORDER BY 1;
SELECT 'fresh|' || "labelDefinitionId" || '|' || regexp_replace("observedAtBucket"::text, '\+00$', '') || '|' || "count"
  FROM "AccountClassificationFreshnessBucket" WHERE "count" <> 0 ORDER BY 1;
SELECT 'reason|' || "labelDefinitionId" || '|' || "reason" || '|' || "count"
  FROM "AccountClassificationReasonCount" WHERE "count" <> 0 ORDER BY 1;
SELECT 'weekly|' || "labelDefinitionId" || '|' || "value" || '|' || "bucket" || '|' || "count"
  FROM "WeeklyReviewSampleBucketCount" WHERE "count" <> 0 ORDER BY 1;
