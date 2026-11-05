-- 検証 (新 DB 側): ラベル保存の再構築結果を、旧 DB の集計 (mig.v_label_old、labels_old.sql の出力) と突き合わせる。
-- 出力は 1 行 1 ゲートの「ゲート名|PASS or FAIL|詳細」。
-- 変数: sample_mod (labels_old.sql と同じ値)
SET TimeZone = 'UTC';
SET work_mem = '256MB';

CREATE TEMP TABLE recon AS
SELECT s."accountId" AS aid, d."key" AS lkey, rvv."ruleVersion" AS rv,
       (a."accountId" IS NOT NULL) AS value, (u.v > 0) AS evaluable,
       a."confidence", a."reason", a."method", a."labeledAt", a."sourceKind", a."sourceId", a."sourceUsername"
FROM "AccountLabelState" s
CROSS JOIN LATERAL unnest(s."versions") WITH ORDINALITY AS u(v, lid)
JOIN "LabelDefinition" d ON d."id" = u.lid
JOIN "LabelRuleVersion" rvv ON rvv."labelDefinitionId" = u.lid AND rvv."versionNo" = abs(u.v)
LEFT JOIN "AccountActiveLabel" a ON a."accountId" = s."accountId" AND a."labelDefinitionId" = u.lid
WHERE u.v <> 0;

-- 旧 DB 側のシャード集計と、新側の再構築 (h_sample) と stg.label_row (h_all) を比べる。
CREATE TEMP TABLE new_s AS
SELECT (hashtext(r.aid::text) % 256) AS shard, count(*) AS n,
       sum(hashtextextended(concat_ws('|', r.aid::text, r.lkey, r.rv, r.value::text, r.evaluable::text,
         CASE WHEN r.value AND r.evaluable THEN concat_ws('|', r."confidence"::text, r."reason", r."method",
           to_char(r."labeledAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS'), r."sourceKind"::text,
           COALESCE(r."sourceId", '<null>'), COALESCE(r."sourceUsername", '<null>')) END), 0)::numeric)
         FILTER (WHERE (hashtext(r.aid::text) % :sample_mod) = 0) AS h_sample
FROM recon r GROUP BY 1;

CREATE TEMP TABLE new_all AS
SELECT (hashtext(l."accountId"::text) % 256) AS shard, count(*) AS n,
       sum(hashtextextended(concat_ws('|', l."accountId"::text, d."key", l."ruleVersion", (l."value" AND l."evaluable")::text,
         l."evaluable"::text, to_char(l."labeledAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS')), 0)::numeric) AS h_all
FROM stg.label_row l JOIN "LabelDefinition" d ON d."id" = l."lid" GROUP BY 1;

CREATE TEMP TABLE old_s AS
SELECT shard, sum(n) AS n, sum(h_sample) AS h_sample, sum(h_all) AS h_all
FROM mig.v_label_old WHERE kind = 'S' GROUP BY shard;

-- 旧 DB は件数 (n) を全行で数えるが、再構築 (new_s) は全行を数えるため、n も比較できる。
SELECT 'labels: shard row count (256 shards)',
       CASE WHEN (SELECT count(*) FROM old_s) > 0
             AND NOT EXISTS (SELECT 1 FROM old_s o FULL JOIN new_s n USING (shard) WHERE o.n IS DISTINCT FROM n.n)
            THEN 'PASS' ELSE 'FAIL' END,
       (SELECT count(*) FROM old_s o FULL JOIN new_s n USING (shard) WHERE o.n IS DISTINCT FROM n.n) || ' shards differ; old rows='
         || COALESCE((SELECT sum(n) FROM old_s), 0) || ', new rows=' || COALESCE((SELECT sum(n) FROM new_s), 0);

SELECT 'labels: reconstruct-from-state content hash (sample accounts, false rows exclude reason/confidence)',
       CASE WHEN NOT EXISTS (SELECT 1 FROM old_s o FULL JOIN new_s n USING (shard) WHERE o.h_sample IS DISTINCT FROM n.h_sample)
            THEN 'PASS' ELSE 'FAIL' END,
       (SELECT count(*) FROM old_s o FULL JOIN new_s n USING (shard) WHERE o.h_sample IS DISTINCT FROM n.h_sample)
         || ' shards differ; sample_mod=' || :sample_mod;

SELECT 'labels: transfer content hash of every row (stg.label_row, incl. labeledAt)',
       CASE WHEN NOT EXISTS (SELECT 1 FROM old_s o FULL JOIN new_all n USING (shard) WHERE o.h_all IS DISTINCT FROM n.h_all OR o.n IS DISTINCT FROM n.n)
            THEN 'PASS' ELSE 'FAIL' END,
       (SELECT count(*) FROM old_s o FULL JOIN new_all n USING (shard) WHERE o.h_all IS DISTINCT FROM n.h_all OR o.n IS DISTINCT FROM n.n) || ' shards differ';

-- ラベル × ruleVersion ごとの true 件数と評価不能件数 (value と evaluable の組ごとの件数) がすべて一致する。
CREATE TEMP TABLE old_g AS
SELECT label_key, rule_version, value, evaluable, sum(n) AS n
FROM mig.v_label_old WHERE kind = 'G' GROUP BY 1, 2, 3, 4;
CREATE TEMP TABLE new_g AS
SELECT lkey AS label_key, rv AS rule_version, value, evaluable, count(*) AS n FROM recon GROUP BY 1, 2, 3, 4;

SELECT 'labels: true count and not-evaluable count per label x ruleVersion (exact)',
       CASE WHEN (SELECT count(*) FROM old_g) > 0
             AND NOT EXISTS (SELECT 1 FROM old_g o FULL JOIN new_g n USING (label_key, rule_version, value, evaluable) WHERE o.n IS DISTINCT FROM n.n)
            THEN 'PASS' ELSE 'FAIL' END,
       (SELECT count(*) FROM old_g o FULL JOIN new_g n USING (label_key, rule_version, value, evaluable) WHERE o.n IS DISTINCT FROM n.n)
         || ' groups differ of ' || (SELECT count(*) FROM old_g) || '; true rows=' || COALESCE((SELECT sum(n) FROM old_g WHERE value), 0)
         || ', not-evaluable rows=' || COALESCE((SELECT sum(n) FROM old_g WHERE NOT evaluable), 0);

-- coverage: ラベルごとの評価済み (evaluable) 件数と、評価不能件数が一致する。
SELECT 'labels: coverage per label (evaluated and not-evaluable counts)',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM (SELECT label_key, sum(n) FILTER (WHERE evaluable) AS ev, sum(n) FILTER (WHERE NOT evaluable) AS ne FROM old_g GROUP BY 1) o
         FULL JOIN (SELECT label_key, sum(n) FILTER (WHERE evaluable) AS ev, sum(n) FILTER (WHERE NOT evaluable) AS ne FROM new_g GROUP BY 1) n USING (label_key)
         WHERE o.ev IS DISTINCT FROM n.ev OR o.ne IS DISTINCT FROM n.ne)
         AND (SELECT count(*) FROM old_g) > 0 THEN 'PASS' ELSE 'FAIL' END,
       (SELECT count(DISTINCT label_key) FROM old_g) || ' labels';

-- 乾式の差分 (relabeler が書き込もうとする差分の代わり): 標本アカウントを再構築した結果が旧 DB の行と食い違う件数が 0。
SELECT 'labels: dry-run diff for the sampled accounts (rows a relabeler would rewrite)',
       CASE WHEN (SELECT count(*) FROM mig.v_dry_old) > 0
             AND NOT EXISTS (
               SELECT 1 FROM mig.v_dry_old o
               FULL JOIN (SELECT r.aid, r.lkey, hashtextextended(concat_ws('|', r.aid::text, r.lkey, r.rv, r.value::text, r.evaluable::text,
                   CASE WHEN r.value AND r.evaluable THEN concat_ws('|', r."confidence"::text, r."reason", r."method",
                     to_char(r."labeledAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS'), r."sourceKind"::text,
                     COALESCE(r."sourceId", '<null>'), COALESCE(r."sourceUsername", '<null>')) END), 0) AS h
                 FROM recon r WHERE r.aid IN (SELECT DISTINCT aid FROM mig.v_dry_old)) n
               USING (aid, lkey) WHERE o.h IS DISTINCT FROM n.h)
            THEN 'PASS' ELSE 'FAIL' END,
       (SELECT count(DISTINCT aid) FROM mig.v_dry_old) || ' accounts, ' || (SELECT count(*) FROM mig.v_dry_old) || ' rows compared';
