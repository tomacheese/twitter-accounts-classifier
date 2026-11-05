-- 旧スキーマと新スキーマに同じ操作を与え、AccountClassificationLatest の集計表が一致することを確かめる入力。
-- どちらの DB にも通る形にするため、ID は引用符付きの数字リテラルで書く (旧は text、新は bigint と smallint)。
-- :anchor は呼び出し側が 1 度だけ決めた基準時刻で、両 DB に同じ時刻を渡して分単位のバケットを揃える。
-- テストデータはすべて架空の値。

\set ON_ERROR_STOP on

-- 新規 insert: 複数ラベル、true/false、確信度の複数バケット、7 日超の古い observedAt (sentinel 行へ丸め込まれる)。
INSERT INTO "AccountClassificationLatest"
  ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion",
   "observedAt", "labeledAt", "evaluable")
VALUES
  ('5001', '1', true, 0.95, 'reason_a', 'rule', 'v1', :'anchor'::timestamptz - interval '1 hour', :'anchor'::timestamptz - interval '1 hour', true),
  ('5002', '1', true, 0.55, 'reason_a', 'rule', 'v1', :'anchor'::timestamptz - interval '2 hours', :'anchor'::timestamptz - interval '2 hours', true),
  ('5003', '1', false, 0.10, 'reason_b', 'rule', 'v1', :'anchor'::timestamptz - interval '3 hours', NULL, false),
  ('5004', '2', true, 0.75, 'reason_c', 'rule', 'v2', :'anchor'::timestamptz - interval '10 days', :'anchor'::timestamptz - interval '10 days', true),
  ('5005', '2', true, 0.75, 'reason_c', 'rule', 'v2', :'anchor'::timestamptz - interval '3 days', NULL, false),
  ('5006', '2', false, 0.00, 'reason_d', 'rule', 'v2', :'anchor'::timestamptz - interval '3 days', :'anchor'::timestamptz - interval '3 days', true);

-- 値の反転 (true から false、false から true) と reason の変更。
UPDATE "AccountClassificationLatest" SET "value" = false, "reason" = 'reason_b', "confidence" = 0.20
  WHERE "accountId" = '5001' AND "labelDefinitionId" = '1';
UPDATE "AccountClassificationLatest" SET "value" = true, "reason" = 'reason_e', "confidence" = 0.90
  WHERE "accountId" = '5003' AND "labelDefinitionId" = '1';

-- true のまま reason だけ変更、ruleVersion の変更、確信度のバケット移動。
UPDATE "AccountClassificationLatest" SET "reason" = 'reason_f' WHERE "accountId" = '5002' AND "labelDefinitionId" = '1';
UPDATE "AccountClassificationLatest" SET "ruleVersion" = 'v3', "confidence" = 0.99
  WHERE "accountId" = '5005' AND "labelDefinitionId" = '2';

-- 同一分内の observedAt の変化と、分をまたぐ変化。
UPDATE "AccountClassificationLatest" SET "observedAt" = "observedAt" + interval '10 seconds'
  WHERE "accountId" = '5002' AND "labelDefinitionId" = '1';
UPDATE "AccountClassificationLatest" SET "observedAt" = "observedAt" + interval '30 minutes'
  WHERE "accountId" = '5006' AND "labelDefinitionId" = '2';

-- evaluable と labeledAt の変更 (weekly review の標本バケットの eligibility 遷移)。
UPDATE "AccountClassificationLatest" SET "evaluable" = true, "labeledAt" = :'anchor'::timestamptz
  WHERE "accountId" = '5005' AND "labelDefinitionId" = '2';
UPDATE "AccountClassificationLatest" SET "evaluable" = false WHERE "accountId" = '5006' AND "labelDefinitionId" = '2';

-- upsert (ON CONFLICT) による更新と新規 insert の混在。
INSERT INTO "AccountClassificationLatest"
  ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion",
   "observedAt", "labeledAt", "evaluable")
VALUES
  ('5001', '1', true, 0.60, 'reason_g', 'rule', 'v1', :'anchor'::timestamptz, :'anchor'::timestamptz, true),
  ('5007', '3', true, 0.40, 'reason_a', 'rule', 'v1', :'anchor'::timestamptz, :'anchor'::timestamptz, true)
ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE SET
  "value" = EXCLUDED."value", "confidence" = EXCLUDED."confidence", "reason" = EXCLUDED."reason",
  "ruleVersion" = EXCLUDED."ruleVersion", "observedAt" = EXCLUDED."observedAt",
  "labeledAt" = EXCLUDED."labeledAt", "evaluable" = EXCLUDED."evaluable";

-- 削除 (true の行と false の行)。
DELETE FROM "AccountClassificationLatest" WHERE "accountId" IN ('5004', '5006');
