-- 移行ツールの自己テスト用に、旧スキーマへ架空のデータを入れる。実在のアカウントや投稿とは無関係。
-- 旧スキーマの空の DB (本番の pg_dump --schema-only を適用したもの) に対して実行する。
-- 件数は SEED_ACCOUNTS (既定 3000) で変えられる。
\if :{?seed_accounts}
\else
\set seed_accounts 3000
\endif

-- 旧 DB のトリガー (集計表の維持、AccountLabelChange の自動記録) を止め、下で明示的に入れた行だけにする。
-- superuser でなければ失敗する (自己テスト用の旧 DB は superuser で作る)。
SET session_replication_role = replica;
SELECT setseed(0.42);

INSERT INTO "LabelDefinition" ("id", "key", "description", "createdAt", "currentRuleVersion") VALUES
  ('lbl_a', 'label_a', 'fake label a', '2026-07-27 00:00:00', '1.10.0'),
  ('lbl_b', 'label_b', 'fake label b', '2026-07-27 00:00:01', '1.2.0'),
  ('lbl_c', 'label_c', 'fake label c', '2026-08-01 00:00:00', '1.0.0'),
  ('lbl_d', 'label_d', 'fake label d', '2026-08-02 00:00:00', NULL),
  ('lbl_e', 'label_e', 'fake label e', '2026-09-01 00:00:00', '2.0.0');

INSERT INTO "Account" ("id", "screenName", "displayName", "bio", "profileImageUrl", "followersCount", "followingCount",
  "tweetCount", "accountCreatedAt", "location", "url", "isBlueVerified", "verifiedType", "firstSeenAt", "lastCrawledAt",
  "updatedAt", "professionalType", "parodyCommentaryFanLabel", "lastRecentTweetsAttemptedAt", "lastRecentTweetsFetchedAt",
  "recentTweetsFetchStatus")
SELECT (9000000000000000000 + i)::text, 'fake_user_' || i, 'Fake User ' || i,
  CASE WHEN i % 7 = 0 THEN NULL ELSE 'fake bio number ' || i END,
  NULL, i % 5000, i % 300, i % 20000,
  timestamp '2015-01-01' + (i % 3000) * interval '1 day', NULL, NULL, i % 11 = 0, NULL,
  timestamp '2026-06-01' + (i % 100) * interval '1 hour', timestamp '2026-10-01' + (i % 500) * interval '1 minute',
  timestamp '2026-10-01' + (i % 500) * interval '1 minute', NULL, NULL,
  CASE WHEN i % 4 = 0 THEN NULL ELSE timestamp '2026-10-02' + (i % 50) * interval '1 minute' END,
  CASE WHEN i % 4 = 0 THEN NULL ELSE timestamp '2026-10-02' + (i % 50) * interval '1 minute' END,
  CASE i % 4 WHEN 0 THEN NULL WHEN 1 THEN 'success' WHEN 2 THEN 'failed' ELSE 'success' END
FROM generate_series(1, :seed_accounts) AS i;

-- AccountLabelLatest。ラベル d は一部のアカウントだけが持つ (配列が途中で抜ける場合を作る)。
-- 評価不能 (evaluable = false) の行は value = false。
INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", "value", "labeledAt", "confidence", "reason", "method",
  "ruleVersion", "sourceId", "sourceKind", "sourceUsername", "evaluable")
SELECT a."id", l.id,
  (v.ev AND v.val), timestamp '2026-10-01' + ((hashtext(a."id" || l.id) & 65535) % 5000) * interval '1 minute',
  ((hashtext(a."id" || l.id) & 1023) / 1024.0)::float8, 'fake reason ' || l.id || ' ' || (hashtext(a."id") & 255),
  l.id, rv, CASE WHEN v.ev AND v.val THEN 'src' || (hashtext(a."id") & 15) END,
  CASE (hashtext(a."id") & 3) WHEN 0 THEN 'legacy' WHEN 1 THEN 'crawl' ELSE 'relabel' END,
  CASE WHEN v.ev AND v.val AND (hashtext(a."id") & 1) = 0 THEN 'fake_user' END, v.ev
FROM "Account" a
CROSS JOIN (VALUES ('lbl_a'), ('lbl_b'), ('lbl_c'), ('lbl_d'), ('lbl_e')) AS l(id)
CROSS JOIN LATERAL (SELECT (hashtext(a."id" || l.id) & 7) > 5 AS val, (hashtext(a."id" || l.id || 'e') & 15) <> 0 AS ev) AS v
CROSS JOIN LATERAL (SELECT (ARRAY['1.0.0', '1.2.0', '1.10.0', '2.0.0'])[1 + (hashtext(a."id" || l.id || 'v') & 3)] AS rv) AS r
WHERE (l.id <> 'lbl_d' OR (hashtext(a."id") & 1) = 0);

INSERT INTO "AccountClassificationLatest" ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method",
  "ruleVersion", "observedAt", "sourceObservationId", "evaluable", "labeledAt")
SELECT a."id", l.id, (hashtext(a."id" || l.id) & 3) = 0, 0.5, 'fake acl reason ' || (hashtext(a."id") & 7), l.id, '1.0.0',
  timestamp '2026-10-20' + (hashtext(a."id") & 255) * interval '1 minute', NULL, true,
  timestamp '2026-10-20' + (hashtext(a."id") & 255) * interval '1 minute'
FROM "Account" a CROSS JOIN (VALUES ('lbl_a'), ('lbl_b')) AS l(id)
WHERE (hashtext(a."id") & 1) = 0;

-- ACL の集計表 (旧 DB ではトリガーが維持している値と同じ形)
INSERT INTO "AccountClassificationValueCount" SELECT "labelDefinitionId", "value", count(*), sum("confidence") FROM "AccountClassificationLatest" GROUP BY 1, 2;
INSERT INTO "AccountClassificationConfidenceBucketCount" SELECT "labelDefinitionId", LEAST(FLOOR("confidence" * 10), 9)::int, count(*) FROM "AccountClassificationLatest" GROUP BY 1, 2;
INSERT INTO "AccountClassificationRuleVersionCount" SELECT "labelDefinitionId", "ruleVersion", count(*) FROM "AccountClassificationLatest" GROUP BY 1, 2;
INSERT INTO "AccountClassificationReasonCount" SELECT "labelDefinitionId", "reason", count(*) FROM "AccountClassificationLatest" WHERE "value" GROUP BY 1, 2;
INSERT INTO "AccountClassificationFreshnessBucket" SELECT "labelDefinitionId", date_trunc('minute', "observedAt"), count(*) FROM "AccountClassificationLatest" GROUP BY 1, 2;
INSERT INTO "AccountClassificationFreshnessBucket" VALUES ('lbl_a', timestamp '1970-01-01', 5);
INSERT INTO "WeeklyReviewSampleBucketCount" VALUES ('lbl_a', true, 1, 3), ('lbl_a', false, 2, 4), ('lbl_b', true, 1, 1);

-- AccountLabelChange。'updated' の行と、LabelDefinition の無い id (廃止済みラベルの名残) を含める。
INSERT INTO "AccountLabelChange" ("id", "accountId", "labelDefinitionId", "changeType", "previousValue", "newValue",
  "previousConfidence", "newConfidence", "previousReason", "newReason", "sourceId", "changedAt")
SELECT 'chg_' || lpad(n::text, 8, '0'), (9000000000000000000 + 1 + (n % :seed_accounts))::text,
  CASE WHEN n % 50 = 0 THEN 'lbl_retired_x' ELSE (ARRAY['lbl_a', 'lbl_b', 'lbl_c'])[1 + n % 3] END,
  (ARRAY['added', 'removed', 'updated'])[1 + n % 3],
  CASE n % 3 WHEN 0 THEN NULL WHEN 1 THEN true ELSE true END, CASE n % 3 WHEN 0 THEN true WHEN 1 THEN false ELSE true END,
  0.4, 0.6, 'prev reason', 'new reason', CASE WHEN n % 2 = 0 THEN 'src_x' END,
  timestamp '2026-08-01' + (n * 7 % 90000) * interval '1 minute'
FROM generate_series(1, :seed_accounts * 3) AS n;

-- Tweet。id は snowflake 形式 (時刻の ms を 22 bit 左に寄せる)。
INSERT INTO "Tweet" ("id", "accountId", "fullText", "createdAt", "retweetCount", "likeCount", "replyCount", "quoteCount",
  "isReply", "inReplyToTweetId", "isAuthorReply", "isRetweet", "retweetedTweetId", "source", "collectedAt",
  "isPaidPromotion", "isPromoted", "hasAiGeneratedMedia", "aiGeneratedDetectionSource", "quotedTweetId",
  "quotedTweetAuthorId", "quotedTweetHasVideo", "foreignVideoSourceCount", "expandedUrls", "cardDestinationUrls",
  "cardDestinationUrlsEvaluated", "hasMedia", "conversationId")
SELECT (((floor(extract(epoch FROM ts) * 1000)::bigint - 1288834974657) << 22) + n)::text,
  (9000000000000000000 + 1 + (n % :seed_accounts))::text, 'fake tweet text ' || n || E'\ttab and\nnewline and \\ backslash',
  ts, n % 5, n % 50, n % 3, 0, n % 4 = 0, CASE WHEN n % 4 = 0 THEN ((9000000000000000000 + n))::text END, false, false, NULL, 'fake source',
  ts + interval '1 hour', false, false, NULL, NULL, NULL, NULL, NULL,
  CASE WHEN ts >= timestamp '2026-08-03' AND n % 3 = 0 THEN NULL WHEN n % 5 = 0 THEN 1 ELSE 0 END,
  CASE WHEN n % 6 = 0 THEN ARRAY['https://example.invalid/' || n] ELSE ARRAY[]::text[] END, ARRAY[]::text[], n % 2 = 0,
  CASE WHEN ts >= timestamp '2026-09-28' AND n % 3 = 0 THEN NULL WHEN n % 4 = 0 THEN true ELSE false END,
  CASE WHEN n % 4 = 0 THEN (9000000000000000000 + n)::text END
FROM (SELECT n, timestamp '2024-01-01' + (n * 997 % 1000) * interval '1 day' + (n % 86400) * interval '1 second' AS ts
      FROM generate_series(1, :seed_accounts * 8) AS n) s;
-- snowflake より前の ID (2011 年より前) を 1 行入れる
INSERT INTO "Tweet" ("id", "accountId", "fullText", "createdAt", "retweetCount", "likeCount", "replyCount", "quoteCount",
  "source", "collectedAt", "expandedUrls", "cardDestinationUrls")
VALUES ('123456789', '9000000000000000001', 'fake old tweet', '2010-01-01', 0, 0, 0, 0, 'fake source', '2026-01-01', ARRAY[]::text[], ARRAY[]::text[]);

INSERT INTO "AccountClassificationObservation" ("id", "accountId", "crawlRunId", "username", "observedAt", "labelCount",
  "createdAt", "snapshotVersion", "classificationSnapshot")
SELECT 'obs_' || n, (9000000000000000000 + 1 + (n % :seed_accounts))::text, NULL, 'fake_user', timestamp '2026-10-25' + n * interval '1 minute',
  3, timestamp '2026-10-25' + n * interval '1 minute', 1, jsonb_build_object('n', n, 'labels', jsonb_build_array('a', 'b'))
FROM generate_series(1, 200) AS n;

-- AnalysisWorkItem。queued、dead、直近の succeeded、30 日より前の succeeded。
INSERT INTO "AnalysisWorkItem" ("id", "kind", "triggerType", "triggerId", "status", "priority", "availableAt", "attemptCount",
  "maxAttempts", "createdAt", "updatedAt")
SELECT 'wi-' || lpad(n::text, 6, '0'), CASE WHEN n % 10 = 0 THEN 'account_summary_refresh' ELSE 'account_relabel' END,
  CASE WHEN n % 10 = 0 THEN 'account_classification_observation' ELSE 'account' END,
  CASE WHEN n % 10 = 0 THEN 'obs_' || (n / 10) ELSE (9000000000000000000 + 1 + (n % :seed_accounts))::text || '-' || n END,
  CASE WHEN n % 100 = 1 THEN 'queued' WHEN n % 100 = 2 THEN 'dead' ELSE 'succeeded' END, 0,
  timestamp '2026-10-01', 1 + (n % 3), 5, timestamp '2026-08-01' + n * interval '1 minute',
  CASE WHEN n % 2 = 0 THEN timestamp '2026-10-30' + (n % 1000) * interval '1 second' ELSE timestamp '2026-08-15' END
FROM generate_series(1, 2000) AS n;

INSERT INTO "AnalysisRun" ("id", "workItemId", "attemptNumber", "startedAt", "finishedAt", "status")
SELECT 'run_' || n, CASE WHEN n % 5 = 0 THEN NULL ELSE 'wi-' || lpad((1 + n % 2000)::text, 6, '0') END, 1,
  timestamp '2026-09-01' + n * interval '1 minute', timestamp '2026-09-01' + n * interval '1 minute' + interval '3 seconds', 'succeeded'
FROM generate_series(1, 300) AS n;

INSERT INTO "LabelMetricSnapshot" ("id", "sourceCrawlRunId", "labelDefinitionId", "observedAt", "generatedAt", "sourceWatermarkAt",
  "evaluatedCount", "trueCount", "prevalence", "completeness", "policyHash", "analyzerVersion", "analysisRunId", "triggerWorkItemId")
SELECT 'lms_' || n || '_' || l.id, NULL, l.id, timestamp '2026-10-01' + n * interval '1 hour', timestamp '2026-10-01' + n * interval '1 hour',
  timestamp '2026-10-01' + n * interval '1 hour', 100, 10, 0.1, 'complete', 'h', 'v1', 'run_' || (1 + n % 300), 'wi-' || lpad((1 + n % 1500)::text, 6, '0')
FROM generate_series(1, 20) AS n CROSS JOIN (VALUES ('lbl_a'), ('lbl_b')) AS l(id);

INSERT INTO "OverviewSnapshot" ("id", "schemaVersion", "generatedAt", "sourceWatermarkAt", "operationalStatus", "qualityStatus", "payload", "analysisRunId", "generationId")
SELECT 'ov_' || n, 1, timestamp '2026-10-01' + n * interval '1 minute', timestamp '2026-10-01', 'ok', 'ok', '{"k": 1}', 'run_' || (1 + n % 300), 'gen_' || n
FROM generate_series(1, 30) AS n;

INSERT INTO "ReadModelGeneration" ("id", "modelKey", "schemaVersion", "status", "startedAt", "analysisRunId")
VALUES ('rmg_1', 'm', 1, 'done', '2026-10-01', 'run_7'), ('rmg_2', 'm', 1, 'done', '2026-10-02', NULL);
INSERT INTO "OperationCycle" ("id", "kind", "sourceType", "sourceId", "triggeredAt", "modelVersion", "updatedAt")
VALUES ('cyc_1', 'k', 'st', 'si', '2026-10-01', 'mv', '2026-10-01');
INSERT INTO "OperationStage" ("id", "cycleId", "stageKey", "sequence", "requiredness", "analysisRunId")
VALUES ('stg_1', 'cyc_1', 'k1', 1, 'required', 'run_9'), ('stg_2', 'cyc_1', 'k2', 2, 'required', NULL);

INSERT INTO "CrawlRun" ("id", "startedAt", "lastHeartbeatAt", "status") VALUES ('crun_1', '2026-10-01', '2026-10-01', 'done');
INSERT INTO "CrawlAccountLabelRun" ("id", "crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion")
SELECT 'calr_' || n, 'crun_1', 'fake_user', (9000000000000000000 + n)::text, 'lbl_a', 'm', '1.0.0' FROM generate_series(1, 50) AS n;

INSERT INTO "Follow" ("id", "followerId", "followeeId")
SELECT 'fol_' || n, (9000000000000000000 + n)::text, (9000000000000000000 + n + 1)::text FROM generate_series(1, 100) AS n;
INSERT INTO "FollowStateChange" ("id", "followerId", "followeeId", "changeType")
SELECT 'fsc_' || n, (9000000000000000000 + n)::text, (9000000000000000000 + n + 1)::text, 'followed' FROM generate_series(1, 20) AS n;
INSERT INTO "BlockRun" ("id", "startedAt", "lastHeartbeatAt", "status") VALUES ('brun_1', '2026-10-01', '2026-10-01', 'done');
INSERT INTO "BlockAccountRun" ("id", "blockRunId", "username", "startedAt", "status") VALUES ('bar_1', 'brun_1', 'fake_user', '2026-10-01', 'done');
INSERT INTO "Block" ("id", "blockerId", "blockedId")
SELECT 'blk_' || n, (9000000000000000000 + n)::text, (9000000000000000000 + n + 2)::text FROM generate_series(1, 60) AS n;
INSERT INTO "BlockOutboxEntry" ("id", "blockAccountRunId", "blockerId", "blockedId", "labelDefinitionId", "confidence", "status")
SELECT 'obx_' || n, 'bar_1', (9000000000000000000 + n)::text, (9000000000000000000 + n + 2)::text, 'lbl_a', 0.9, 'done' FROM generate_series(1, 60) AS n;
INSERT INTO "BlockAction" ("id", "blockAccountRunId", "blockerId", "blockedId", "labelDefinitionId", "confidence", "result", "outboxEntryId")
SELECT 'bac_' || n, 'bar_1', (9000000000000000000 + n)::text, (9000000000000000000 + n + 2)::text, 'lbl_a', 0.9, 'ok', 'obx_' || n FROM generate_series(1, 60) AS n;

INSERT INTO "ReplyHijackEvidence" ("id", "accountId", "targetTweetId", "ruleVersion", "observedAt", "swarmSize", "averageSimilarity", "spanHours", "replyTweetIds")
SELECT 'rhe_' || n, (9000000000000000000 + n)::text, (1700000000000000000 + n)::text, '1.0.0', '2026-10-01', 3, 0.9, 1.5,
  ARRAY[(1700000000000000100 + n)::text, (1700000000000000200 + n)::text] FROM generate_series(1, 30) AS n;

INSERT INTO "AccountSummaryLatest" ("accountId", "normalizedScreenName", "normalizedDisplayName", "searchDocument", "profileObservedAt",
  "activeLabelKeys", "activeLabelCount", "updatedAt")
SELECT (9000000000000000000 + n)::text, 'fake_user_' || n, 'fake user ' || n, 'fake user ' || n, '2026-10-01',
  ARRAY['label_a'], CASE WHEN n % 3 = 0 THEN 0 ELSE 1 END, '2026-10-01' FROM generate_series(1, 300) AS n;
INSERT INTO "LabeledAccountCounter" ("id", "labeledAccounts", "updatedAt") VALUES ('global', 200, '2026-10-01');

INSERT INTO "BioDuplicateClusterSize" ("clusterKey", "size", "memberIds") VALUES ('c1', 2, ARRAY['9000000000000000001', '9000000000000000002']);
INSERT INTO "RelabelScanCursor" ("id", "lastScannedAccountId", "updatedAt") VALUES ('singleton', '9000000000000000100', '2026-10-01');
INSERT INTO "StorageCapacityState" ("id", "availableGib", "usedPercent", "measuredAt", "updatedAt") VALUES ('s', 100, 50, '2026-10-01', '2026-10-01');
INSERT INTO "CrawlAuthorCheckpoint" ("id", "crawlRunId", "username", "authorId", "status") VALUES ('cac_1', 'crun_1', 'fake_user', '9000000000000000005', 'done');

ANALYZE;
