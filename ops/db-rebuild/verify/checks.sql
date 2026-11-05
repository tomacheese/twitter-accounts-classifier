-- 検証 (新 DB 側だけで完結するゲート)。出力は 1 行 1 ゲートの「ゲート名|PASS or FAIL|詳細」。
-- 変数: db_size_limit_gib (全量での上限、既定 70)、scale (シャード実行の拡大率。全量は 1)
SET TimeZone = 'UTC';

-- 不変条件: 有効なラベルの行は、状態の versions が同じ ruleVersionNo の正の値でなければならない。
-- 旧 DB の「evaluable = false かつ value = true は存在しない」に対応する (評価不能なのに true の行が無い)。
SELECT 'invariant: no active label with a non-positive or mismatching versions entry',
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END, n || ' rows'
FROM (SELECT count(*) AS n FROM "AccountActiveLabel" a
      LEFT JOIN "AccountLabelState" s ON s."accountId" = a."accountId"
      WHERE s."versions"[a."labelDefinitionId"] IS DISTINCT FROM a."ruleVersionNo") x;

SELECT 'invariant: stg.label_row has no evaluable=false AND value=true row',
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END, n || ' rows'
FROM (SELECT count(*) AS n FROM stg.label_row WHERE NOT "evaluable" AND "value") x;

SELECT 'invariant: AccountLabelState.evaluatedAt = max(labeledAt) of the account''s rows',
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END, n || ' accounts differ'
FROM (SELECT count(*) AS n FROM "AccountLabelState" s
      JOIN (SELECT "accountId", max("labeledAt") AS m FROM stg.label_row GROUP BY 1) l ON l."accountId" = s."accountId"
      WHERE s."evaluatedAt" IS DISTINCT FROM l.m) x;

SELECT 'invariant: AccountLabelState row count = distinct accounts, entries = rows of stg.label_row',
       CASE WHEN a = b AND c = d THEN 'PASS' ELSE 'FAIL' END,
       'state rows=' || a || ' accounts=' || b || '; nonzero entries=' || c || ' label rows=' || d
FROM (SELECT (SELECT count(*) FROM "AccountLabelState") AS a,
             (SELECT count(DISTINCT "accountId") FROM stg.label_row) AS b,
             (SELECT COALESCE(sum((SELECT count(*) FROM unnest(s."versions") v WHERE v <> 0)), 0) FROM "AccountLabelState" s) AS c,
             (SELECT count(*) FROM stg.label_row) AS d) x;

SELECT 'invariant: versionNo starts at 1 and is contiguous per label; no 0',
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END, n || ' labels violate'
FROM (SELECT count(*) AS n FROM (SELECT "labelDefinitionId", min("versionNo") AS mn, max("versionNo") AS mx, count(*) AS c
        FROM "LabelRuleVersion" GROUP BY 1) g WHERE g.mn <> 1 OR g.mx <> g.c) x;

-- viewer と crawl は「Account 1 行につき AccountCrawlState がちょうど 1 行」を前提にする。
SELECT 'invariant: AccountCrawlState has exactly one row per Account (counts equal)',
       CASE WHEN a = b THEN 'PASS' ELSE 'FAIL' END, 'Account=' || a || ' AccountCrawlState=' || b
FROM (SELECT (SELECT count(*) FROM "Account") AS a, (SELECT count(*) FROM "AccountCrawlState") AS b) x;

SELECT 'invariant: no Account without AccountCrawlState, no orphan AccountCrawlState',
       CASE WHEN a = 0 AND b = 0 THEN 'PASS' ELSE 'FAIL' END,
       a || ' accounts without crawl state, ' || b || ' orphan crawl states'
FROM (SELECT (SELECT count(*) FROM "Account" a WHERE NOT EXISTS (SELECT 1 FROM "AccountCrawlState" c WHERE c."accountId" = a."id")) AS a,
             (SELECT count(*) FROM "AccountCrawlState" c WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = c."accountId")) AS b) x;

SELECT 'invariant: AccountCrawlState.lastCrawledAt is never NULL',
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END, n || ' rows'
FROM (SELECT count(*) AS n FROM "AccountCrawlState" WHERE "lastCrawledAt" IS NULL) x;

SELECT 'mapping: LabelDefinition rows = old label map (smallint ids 1..N)',
       CASE WHEN a = b AND a = c THEN 'PASS' ELSE 'FAIL' END, 'LabelDefinition=' || a || ' map=' || b || ' max id=' || c
FROM (SELECT (SELECT count(*) FROM "LabelDefinition") AS a, (SELECT count(*) FROM mig.label_map) AS b,
             (SELECT COALESCE(max(id), 0) FROM "LabelDefinition") AS c) x;

-- LabelDefinition を参照する列すべてについて、LabelDefinition に無い id を参照している行が 0 (未変換の id が無い)。
SELECT format('SELECT %L AS gate, CASE WHEN count(*) = 0 THEN %L ELSE %L END AS status, count(*) || %L AS detail '
              'FROM %I t WHERE NOT EXISTS (SELECT 1 FROM "LabelDefinition" d WHERE d."id" = t.%I)',
              'mapping: unmapped label ids in ' || c.table_name || '.' || c.column_name, 'PASS', 'FAIL', ' rows',
              c.table_name, c.column_name)
FROM information_schema.columns c
JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
WHERE c.table_schema = 'public' AND c.column_name = 'labelDefinitionId'
ORDER BY c.table_name
\gexec

-- LabelDefinition.id を参照する列が、すべて smallint であること (baseline の検査と同じ観点を、投入後の DB で確認する)。
SELECT 'mapping: every labelDefinitionId column is smallint',
       CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END, n || ' columns are not smallint'
FROM (SELECT count(*) AS n FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'labelDefinitionId' AND data_type <> 'smallint') x;

SELECT 'restore: every dropped index, constraint and FK was restored',
       CASE WHEN a = 0 AND b = 0 THEN 'PASS' ELSE 'FAIL' END, a || ' indexes/constraints and ' || b || ' FKs not restored'
FROM (SELECT (SELECT count(*) FROM mig.index_def WHERE NOT restored) AS a, (SELECT count(*) FROM mig.fk_def WHERE NOT restored) AS b) x;

SELECT 'restore: no invalid index', CASE WHEN n = 0 THEN 'PASS' ELSE 'FAIL' END, n || ' invalid indexes'
FROM (SELECT count(*) AS n FROM pg_index WHERE NOT indisvalid) x;

SELECT 'tweet: all child partitions attached; no row outside any partition',
       CASE WHEN a = (SELECT count(*) FROM mig.tweet_part) AND b = 0 THEN 'PASS' ELSE 'FAIL' END,
       a || ' partitions attached; default/unattached rows=' || b
FROM (SELECT (SELECT count(*) FROM pg_inherits WHERE inhparent = '"Tweet"'::regclass) AS a, 0 AS b) x;

-- 参考 (合否なし): FK を張らない巨大表の孤児。旧 DB にも元から存在しうる。
SELECT 'info: Tweet rows whose accountId has no Account', 'INFO', count(*) || ' rows'
FROM "Tweet" t WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = t."accountId");
SELECT 'info: AccountLabelState rows whose accountId has no Account', 'INFO', count(*) || ' rows'
FROM "AccountLabelState" t WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = t."accountId");
SELECT 'info: AccountClassificationLatest rows whose accountId has no Account', 'INFO', count(*) || ' rows'
FROM "AccountClassificationLatest" t WHERE NOT EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = t."accountId");

SELECT 'size: pg_database_size <= ' || :'db_size_limit_gib' || ' GiB (shard runs scale the growth over the empty baseline by ' || :'scale' || ')',
       CASE WHEN (sz - empty) * :'scale'::numeric + empty <= :'db_size_limit_gib'::numeric * 1073741824 THEN 'PASS' ELSE 'FAIL' END,
       pg_size_pretty(sz) || ' now, ' || pg_size_pretty(empty) || ' empty, extrapolated ' || pg_size_pretty(((sz - empty) * :'scale'::numeric + empty)::bigint)
FROM (SELECT pg_database_size(current_database()) AS sz, (SELECT value::bigint FROM mig.meta WHERE key = 'empty_db_size') AS empty) x;
