-- finalize: stg.label_row (旧 AccountLabelLatest の行) から、新しいラベル保存を組み立てる。
--   LabelDefinition、LabelRuleVersion、AccountLabelState、AccountActiveLabel
-- psql の変数: work_mem (例: 256MB)。単一トランザクション (psql -1) で実行する。
-- テーブルは空 (または TRUNCATE 済み) で、TRUNCATE と同じトランザクションで INSERT するため、
-- wal_level = minimal では WAL が省略される。

SET LOCAL work_mem = :'work_mem';

-- 不変条件: 評価不能 (evaluable = false) の行は value = false でなければならない。
-- 10_label_row.sql の投入時にも検査しているが、投入済みの全行に対しても確認する。
DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM stg.label_row WHERE NOT "evaluable" AND "value";
  IF n <> 0 THEN
    RAISE EXCEPTION 'ASSERT_FAILED: % rows with evaluable=false and value=true', n;
  END IF;
END
$$;

TRUNCATE "AccountActiveLabel", "AccountLabelState", "LabelRuleVersion", "LabelDefinition" RESTART IDENTITY;

-- LabelDefinition。id は変換表の新 id をそのまま使う (GENERATED ALWAYS のため OVERRIDING SYSTEM VALUE)。
-- 定義が無かった id (placeholder) は、投入時刻で廃止済みにする。
INSERT INTO "LabelDefinition" ("id", "currentRuleVersionNo", "retiredAt", "createdAt", "key", "description")
OVERRIDING SYSTEM VALUE
SELECT m.new_id,
       NULL,
       CASE WHEN m.placeholder THEN now() END,
       COALESCE(m.created_at::timestamp AT TIME ZONE 'UTC', now()),
       m.key,
       m.description
FROM mig.label_map m
ORDER BY m.new_id;

SELECT setval(pg_get_serial_sequence('"LabelDefinition"', 'id'), (SELECT max(new_id) FROM mig.label_map));

-- LabelRuleVersion。ラベルごとの distinct な ruleVersion に、1 始まりの versionNo を振る。
-- 並びは数字とドットだけの版を数値の列として比べ、それ以外は C 照合順にする (1.15.1 が 1.2.0 より後になる)。
-- LabelDefinition.currentRuleVersion が行に一度も現れていない場合も、versionNo を振る。
WITH seen AS (
  SELECT DISTINCT "lid" AS label_id, "ruleVersion" AS rule_version FROM stg.label_row
  UNION
  SELECT m.new_id, m.current_rule_version FROM mig.label_map m WHERE m.current_rule_version IS NOT NULL
)
INSERT INTO "LabelRuleVersion" ("labelDefinitionId", "versionNo", "ruleVersion")
SELECT label_id,
       row_number() OVER (
         PARTITION BY label_id
         ORDER BY CASE WHEN rule_version ~ '^[0-9]+(\.[0-9]+)*$' THEN string_to_array(rule_version, '.')::int[] END NULLS LAST,
                  rule_version COLLATE "C"
       )::smallint,
       rule_version
FROM seen;

UPDATE "LabelDefinition" d
SET "currentRuleVersionNo" = v."versionNo"
FROM mig.label_map m
JOIN "LabelRuleVersion" v ON v."labelDefinitionId" = m.new_id AND v."ruleVersion" = m.current_rule_version
WHERE d."id" = m.new_id;

-- AccountLabelState。versions の添字は LabelDefinition.id、値は +versionNo (評価済み)、-versionNo (評価不能)、0 (未評価)。
-- 全ラベルが 1..N で連続して揃うアカウントは、並べ替えた配列をそのまま使う。揃わないアカウントは、
-- 添字ごとに探して 0 で埋める。evaluatedAt は、そのアカウントの labeledAt の最大値。rev は 0 から始める。
INSERT INTO "AccountLabelState" ("accountId", "evaluatedAt", "rev", "versions")
SELECT s."accountId", s.evaluated_at, 0,
       CASE WHEN cardinality(s.ids) = s.ids[cardinality(s.ids)] THEN s.vs
            ELSE ARRAY(
              SELECT COALESCE(s.vs[array_position(s.ids, g::smallint)], 0)::smallint
              FROM generate_series(1, s.ids[cardinality(s.ids)]) AS g
            )
       END
FROM (
  SELECT r."accountId",
         max(r."labeledAt") AS evaluated_at,
         array_agg(r."lid" ORDER BY r."lid") AS ids,
         array_agg((CASE WHEN r."evaluable" THEN v."versionNo" ELSE -v."versionNo" END)::smallint ORDER BY r."lid") AS vs
  FROM stg.label_row r
  JOIN "LabelRuleVersion" v ON v."labelDefinitionId" = r."lid" AND v."ruleVersion" = r."ruleVersion"
  GROUP BY r."accountId"
) s;

-- AccountActiveLabel (value = true かつ evaluable = true の行だけ)。監査トリガーは load.sh が投入前に無効にしている。
INSERT INTO "AccountActiveLabel"
  ("accountId", "labeledAt", "confidence", "labelDefinitionId", "ruleVersionNo", "sourceKind", "method", "reason", "sourceId", "sourceUsername")
SELECT r."accountId", r."labeledAt", r."confidence", r."lid", v."versionNo", r."sourceKind", r."method", r."reason", r."sourceId", r."sourceUsername"
FROM stg.label_row r
JOIN "LabelRuleVersion" v ON v."labelDefinitionId" = r."lid" AND v."ruleVersion" = r."ruleVersion"
WHERE r."value" AND r."evaluable";
