BEGIN;
SET LOCAL lock_timeout = '3s';
-- AccountClassificationLatest/AccountLabelLatest は億行規模で、行ごとに集計トリガーが発火する。
-- 先例の 5min では収まる根拠がないため、1 文あたりの上限を広げる。
SET LOCAL statement_timeout = '30min';

-- topic_* ルール群は正式に廃止する。
-- 外部キーを持たない集計・メトリクス系テーブルは LabelDefinition の削除では孤立行が残るため、
-- labelDefinitionId を持つ全テーブルを子→親の順に明示的に削除する。
-- 集計テーブルは AccountClassificationLatest/AccountLabelLatest のトリガーが decrement するため、
-- 行テーブルを先に削除し、トリガーが残した 0 件の sentinel 行ごと集計テーブルを最後に削除する。
-- 対象キーは固定リテラルのみで、存在しないキーは no-op となるため再適用しても安全である。
DO $$
DECLARE
  v_keys CONSTANT TEXT[] := ARRAY[
    'topic_anime', 'topic_beauty', 'topic_crypto', 'topic_finance', 'topic_fitness',
    'topic_food', 'topic_gaming', 'topic_idol', 'topic_illustration', 'topic_movie',
    'topic_music', 'topic_nsfw', 'topic_parenting', 'topic_pets', 'topic_politics',
    'topic_sports', 'topic_tech', 'topic_travel', 'topic_vrchat', 'topic_vtuber'
  ];
  v_tables CONSTANT TEXT[] := ARRAY[
    'BlockAction',
    'BlockOutboxEntry',
    'AccountLabelChange',
    'AccountClassificationLatest',
    'AccountLabelLatest',
    'CrawlAccountLabelRun',
    'WeeklyReviewSampleBucketCount',
    'AccountClassificationValueCount',
    'AccountClassificationConfidenceBucketCount',
    'AccountClassificationRuleVersionCount',
    'AccountClassificationFreshnessBucket',
    'AccountClassificationReasonCount',
    'LabelMetricSnapshot',
    'LabelMetricDaily',
    'LabelSummaryCurrent'
  ];
  v_ids TEXT[];
  v_table TEXT;
  v_rows BIGINT;
BEGIN
  SELECT COALESCE(array_agg(id), ARRAY[]::TEXT[]) INTO v_ids
    FROM "LabelDefinition" WHERE key = ANY(v_keys);

  FOREACH v_table IN ARRAY v_tables LOOP
    EXECUTE format('DELETE FROM %I WHERE "labelDefinitionId" = ANY($1)', v_table) USING v_ids;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RAISE NOTICE 'retire_topic_rules: deleted % rows from %', v_rows, v_table;
  END LOOP;

  -- activeLabelCount は activeLabelKeys の要素数と常に一致させる。
  -- counter trigger が activeLabelCount の 0 跨ぎで LabeledAccountCounter を更新するため、同じ UPDATE で書き換える。
  UPDATE "AccountSummaryLatest" SET
    "activeLabelKeys" = ARRAY(SELECT k FROM unnest("activeLabelKeys") AS k WHERE k <> ALL(v_keys)),
    "activeLabelCount" = cardinality(ARRAY(SELECT k FROM unnest("activeLabelKeys") AS k WHERE k <> ALL(v_keys)))
  WHERE "activeLabelKeys" && v_keys;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'retire_topic_rules: updated % rows of AccountSummaryLatest', v_rows;

  DELETE FROM "LabelDefinition" WHERE id = ANY(v_ids);
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'retire_topic_rules: deleted % rows from LabelDefinition', v_rows;
END
$$;

-- follow-graph signal は topic ルールだけが利用しており、読み手の撤去に合わせて収集とテーブルも廃止する。
DROP TABLE IF EXISTS "LabelingFollowSample";

COMMIT;
