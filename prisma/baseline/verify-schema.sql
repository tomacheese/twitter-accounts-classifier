-- baseline を適用した DB のカタログ検査。失敗すると例外で止まる。
-- verify.sh から、tweet-hash.sql 版と tweet-range.sql 版の両方に対して実行する。
-- psql 変数 tweet_variant に 'hash' か 'range' を渡す。

\set ON_ERROR_STOP on
\o /dev/null

CREATE FUNCTION pg_temp.expect(p_ok boolean, p_message text) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'schema check failed: %', p_message;
  END IF;
END
$$;

-- 1. timestamp without time zone の列がない。
SELECT pg_temp.expect(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'timestamp without time zone'
  ),
  'timestamp without time zone columns remain'
);

-- 2. LabelDefinition を参照する列の一覧。全件が smallint であり、一覧が想定と一致する。
SELECT pg_temp.expect(
  (SELECT array_agg(table_name::text ORDER BY table_name)
   FROM information_schema.columns
   WHERE table_schema = 'public' AND column_name = 'labelDefinitionId')
  = ARRAY[
    'AccountActiveLabel', 'AccountClassificationConfidenceBucketCount',
    'AccountClassificationFreshnessBucket', 'AccountClassificationLatest',
    'AccountClassificationReasonCount', 'AccountClassificationRuleVersionCount',
    'AccountClassificationValueCount', 'AccountLabelChange', 'BlockAction', 'BlockOutboxEntry',
    'CrawlAccountLabelRun', 'LabelMetricDaily', 'LabelMetricSnapshot', 'LabelRuleVersion',
    'LabelSummaryCurrent', 'RelabelCoverageSnapshot', 'WeeklyReviewSampleBucketCount'
  ],
  'labelDefinitionId column inventory differs'
);
SELECT pg_temp.expect(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name = 'labelDefinitionId' AND udt_name <> 'int2'
  ),
  'a labelDefinitionId column is not smallint'
);
SELECT pg_temp.expect(
  (SELECT udt_name FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'LabelDefinition' AND column_name = 'id') = 'int2',
  'LabelDefinition.id is not smallint'
);

-- 3. Account と Tweet の ID を持つ列は bigint。
SELECT pg_temp.expect(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('accountId', 'followerId', 'followeeId', 'blockerId', 'blockedId', 'authorId',
                          'targetTweetId', 'lastScannedAccountId', 'inReplyToTweetId', 'conversationId',
                          'quotedTweetAuthorId')
      AND udt_name <> 'int8'
  ),
  'an account or tweet id column is not bigint'
);
SELECT pg_temp.expect(
  (SELECT udt_name FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'Account' AND column_name = 'id') = 'int8'
  AND (SELECT udt_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'Tweet' AND column_name = 'id') = 'int8',
  'Account.id or Tweet.id is not bigint'
);

-- 4. すべてのテーブルに PK がある (パーティションの子を除く)。
SELECT pg_temp.expect(
  NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    WHERE c.relkind IN ('r', 'p') AND NOT c.relispartition
      AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')
  ),
  'a table has no primary key'
);

-- 5. 巨大・ホットな表には FK がない (どちら側の参照も)。
SELECT pg_temp.expect(
  NOT EXISTS (
    SELECT 1 FROM pg_constraint k
    WHERE k.contype = 'f'
      AND (k.conrelid::regclass::text IN ('"Tweet"', '"AccountLabelState"', '"AccountActiveLabel"', '"AccountClassificationLatest"')
        OR k.confrelid::regclass::text IN ('"Tweet"', '"AccountLabelState"', '"AccountActiveLabel"', '"AccountClassificationLatest"'))
  ),
  'a foreign key touches a large hot table'
);

-- 6. テーブルごとの storage parameter。
SELECT pg_temp.expect(
  (SELECT reloptions FROM pg_class WHERE oid = '"AccountLabelState"'::regclass)
    @> ARRAY['fillfactor=75', 'autovacuum_vacuum_scale_factor=0.02'],
  'AccountLabelState reloptions'
);
SELECT pg_temp.expect(
  (SELECT reloptions FROM pg_class WHERE oid = '"Account"'::regclass) @> ARRAY['fillfactor=80'],
  'Account fillfactor'
);
SELECT pg_temp.expect(
  (SELECT reloptions FROM pg_class WHERE oid = '"AccountCrawlState"'::regclass) @> ARRAY['fillfactor=70'],
  'AccountCrawlState fillfactor'
);
SELECT pg_temp.expect(
  (SELECT reloptions FROM pg_class WHERE oid = '"AnalysisWorkItem"'::regclass) @> ARRAY['fillfactor=50'],
  'AnalysisWorkItem fillfactor'
);
SELECT pg_temp.expect(
  (SELECT reloptions FROM pg_class WHERE oid = '"AnalysisWorkItem"'::regclass)
    @> ARRAY['autovacuum_vacuum_scale_factor=0', 'autovacuum_vacuum_threshold=1000'],
  'AnalysisWorkItem autovacuum'
);
SELECT pg_temp.expect(
  (SELECT indpred IS NOT NULL FROM pg_index WHERE indexrelid = '"AnalysisWorkItem_queue_idx"'::regclass),
  'AnalysisWorkItem queue index is partial'
);
SELECT pg_temp.expect(
  (SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
    WHERE attrelid = '"AnalysisWorkItemDone"'::regclass AND attnum > 0 AND NOT attisdropped)
    = ARRAY['completedAt', 'createdAt', 'workItemId', 'attemptCount', 'kind', 'triggerType', 'triggerId'],
  'AnalysisWorkItemDone columns'
);
SELECT pg_temp.expect(
  NOT EXISTS (
    SELECT 1 FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = '"Tweet"'::regclass
      AND NOT (COALESCE(c.reloptions, ARRAY[]::text[]) @>
        ARRAY['fillfactor=90', 'autovacuum_vacuum_insert_scale_factor=0.01'])
  ),
  'a Tweet partition lacks fillfactor / autovacuum settings'
);

-- 7. Tweet のパーティション。
SELECT pg_temp.expect(
  (SELECT partstrat FROM pg_partitioned_table WHERE partrelid = '"Tweet"'::regclass)
    = CASE :'tweet_variant' WHEN 'hash' THEN 'h' ELSE 'r' END,
  'Tweet partition strategy'
);
SELECT pg_temp.expect(
  CASE :'tweet_variant'
    WHEN 'hash' THEN (SELECT count(*) FROM pg_inherits WHERE inhparent = '"Tweet"'::regclass) = 32
    ELSE (SELECT count(*) FROM pg_inherits WHERE inhparent = '"Tweet"'::regclass) = 51
  END,
  'Tweet partition count'
);
SELECT pg_temp.expect(
  (SELECT array_agg(a.attname::text ORDER BY k.ord)
   FROM pg_index x
   JOIN LATERAL unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) ON true
   JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum
   WHERE x.indrelid = '"Tweet"'::regclass AND x.indisprimary)
  = CASE :'tweet_variant' WHEN 'hash' THEN ARRAY['accountId', 'id'] ELSE ARRAY['id'] END,
  'Tweet primary key columns'
);
-- 親表の部分インデックス (reply corpus) がある。
SELECT pg_temp.expect(
  EXISTS (
    SELECT 1 FROM pg_index x
    WHERE x.indrelid = '"Tweet"'::regclass AND x.indpred IS NOT NULL
      AND x.indexrelid = '"Tweet_reply_corpus_idx"'::regclass
  ),
  'Tweet reply corpus partial index'
);
-- 削除した 4 列がなく、配列列は NULL 可で既定値がない。
SELECT pg_temp.expect(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Tweet'
      AND column_name IN ('quoteCount', 'retweetedTweetId', 'quotedTweetId', 'source')
  ),
  'dropped Tweet columns remain'
);
SELECT pg_temp.expect(
  (SELECT count(*) FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'Tweet'
     AND column_name IN ('expandedUrls', 'cardDestinationUrls')
     AND is_nullable = 'YES' AND column_default IS NULL) = 2,
  'Tweet array columns must be nullable without default'
);

-- 8. native enum と IDENTITY 列。
SELECT pg_temp.expect(
  (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
   FROM pg_enum e WHERE e.enumtypid = '"AccountLabelChangeType"'::regtype)
  = ARRAY['added', 'removed', 'unevaluable'],
  'AccountLabelChangeType labels'
);
SELECT pg_temp.expect(
  (SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
   FROM pg_enum e WHERE e.enumtypid = '"RecentTweetsFetchStatus"'::regtype)
  = ARRAY['success', 'failed'],
  'RecentTweetsFetchStatus labels'
);
SELECT pg_temp.expect(
  (SELECT array_agg(c.relname::text ORDER BY c.relname)
   FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
   WHERE a.attidentity = 'a' AND c.relkind = 'r' AND a.attname = 'id')
  = ARRAY['AccountLabelChange', 'AnalysisRun', 'AnalysisWorkItem', 'LabelDefinition'],
  'identity columns'
);
SELECT pg_temp.expect(
  (SELECT atttypid::regtype::text FROM pg_attribute WHERE attrelid = '"AccountLabelChange"'::regclass AND attname = 'id') = 'integer'
  AND (SELECT atttypid::regtype::text FROM pg_attribute WHERE attrelid = '"AnalysisRun"'::regclass AND attname = 'id') = 'integer'
  AND (SELECT atttypid::regtype::text FROM pg_attribute WHERE attrelid = '"AnalysisWorkItem"'::regclass AND attname = 'id') = 'integer',
  'queue and change ids are not int4'
);

-- 9. Prisma で表現できないオブジェクトが存在する。
SELECT pg_temp.expect(
  (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
    'AccountCrawlState_recent_tweets_unattempted_idx',
    'AccountClassificationLatest_weekly_review_sample_idx',
    'AccountSummaryLatest_normalizedDisplayName_gin_idx',
    'AccountSummaryLatest_searchDocument_gin_idx',
    'AccountLabelChange_sourceLabelId_key',
    'Tweet_reply_corpus_idx')) = 6,
  'raw indexes missing'
);
SELECT pg_temp.expect(
  (SELECT indexdef FROM pg_indexes WHERE indexname = 'AccountLabelChange_sourceLabelId_key')
    ~ 'UNIQUE.*WHERE \("sourceLabelId" IS NOT NULL\)',
  'sourceLabelId unique index must be partial and unique'
);
SELECT pg_temp.expect(
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN (
    'account_active_label_change_audit_trigger',
    'account_classification_latest_aggregate_trigger',
    'weekly_review_sample_bucket_count_trigger',
    'account_summary_latest_labeled_counter_trigger')) = 4,
  'triggers missing'
);
-- AccountActiveLabel に付く監査トリガーは 1 本だけで、INSERT・UPDATE・DELETE を拾う。
SELECT pg_temp.expect(
  (SELECT count(*) FROM pg_trigger WHERE tgrelid = '"AccountActiveLabel"'::regclass AND NOT tgisinternal) = 1
  AND (SELECT tgtype & (4 | 8 | 16) FROM pg_trigger
       WHERE tgrelid = '"AccountActiveLabel"'::regclass AND NOT tgisinternal) = (4 | 8 | 16),
  'AccountActiveLabel must have exactly one INSERT/DELETE/UPDATE trigger'
);
-- AccountLabelState には監査トリガーを付けない。
SELECT pg_temp.expect(
  NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '"AccountLabelState"'::regclass AND NOT tgisinternal),
  'AccountLabelState must not have triggers'
);
SELECT pg_temp.expect(
  (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
   WHERE p.proname IN ('set_label_result', 'account_active_label_change_audit')
     AND p.prosecdef) = 2,
  'set_label_result and the audit function must be SECURITY DEFINER'
);
-- ACL に (labelDefinitionId, value, accountId) のインデックスを作らない。
SELECT pg_temp.expect(
  (SELECT array_agg(indexname::text ORDER BY indexname) FROM pg_indexes
   WHERE tablename = 'AccountClassificationLatest')
  = ARRAY['AccountClassificationLatest_pkey', 'AccountClassificationLatest_weekly_review_sample_idx'],
  'AccountClassificationLatest index set'
);
SELECT pg_temp.expect(
  (SELECT attcompression FROM pg_attribute
   WHERE attrelid = '"AccountClassificationObservation"'::regclass AND attname = 'classificationSnapshot') = 'l',
  'classificationSnapshot must use lz4'
);
-- Account の更新頻度の高い列と、使用実績のないインデックスがない。
SELECT pg_temp.expect(
  (SELECT array_agg(indexname::text ORDER BY indexname) FROM pg_indexes WHERE tablename = 'Account')
  = ARRAY['Account_pkey'],
  'Account must only have its primary key'
);
SELECT pg_temp.expect(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Account'
      AND column_name IN ('lastCrawledAt', 'lastRecentTweetsAttemptedAt', 'lastRecentTweetsFetchedAt', 'recentTweetsFetchStatus')
  ),
  'hot columns must live in AccountCrawlState'
);

-- 10. 大きい表の列は、8B 境界、4B、2B、1B、可変長の順に並ぶ。
SELECT pg_temp.expect(
  NOT EXISTS (
    WITH cols AS (
      SELECT c.relname, a.attnum,
             CASE WHEN t.typlen = -1 THEN 0
                  ELSE CASE t.typalign WHEN 'd' THEN 4 WHEN 'i' THEN 3 WHEN 's' THEN 2 ELSE 1 END END AS rank
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE a.attnum > 0 AND NOT a.attisdropped AND c.relkind IN ('r', 'p')
        AND c.relname IN ('Account', 'AccountCrawlState', 'Tweet', 'AccountLabelState', 'AccountActiveLabel',
                          'AccountClassificationLatest', 'AccountLabelChange', 'AnalysisWorkItem',
                          'AccountClassificationObservation')
    )
    SELECT 1 FROM cols x JOIN cols y ON y.relname = x.relname AND y.attnum > x.attnum
    WHERE (CASE WHEN x.rank = 0 THEN -1 ELSE x.rank END) < (CASE WHEN y.rank = 0 THEN -1 ELSE y.rank END)
  ),
  'column order wastes padding'
);

\o
SELECT 'schema checks passed (' || :'tweet_variant' || ')' AS result;
