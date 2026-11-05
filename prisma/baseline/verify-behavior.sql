-- set_label_result と監査トリガーの逐次テスト。失敗すると例外で止まる。
-- 並行実行と権限のテストは verify.sh が別のセッションで行う。
-- テストデータはすべて架空の値で、アカウント ID は 1000 番台の連番を使う。

\set ON_ERROR_STOP on
\o /dev/null

CREATE FUNCTION pg_temp.expect(p_ok boolean, p_message text) RETURNS void
  LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'behavior check failed: %', p_message;
  END IF;
END
$$;

-- 1 行分の呼び出しを短く書くためのヘルパー (テスト専用)。
-- 戻り値は set_label_result の戻り値 (rev の比較に失敗したアカウントの配列)。
CREATE FUNCTION pg_temp.put(
  p_account bigint, p_label smallint, p_rev integer, p_outcome smallint, p_version smallint,
  p_confidence double precision DEFAULT NULL, p_reason text DEFAULT NULL,
  p_evaluated_at timestamptz DEFAULT now(), p_source_id text DEFAULT 'run'
) RETURNS bigint[] LANGUAGE sql AS $$
  SELECT set_label_result(
    ARRAY[p_account], ARRAY[p_label], ARRAY[p_rev], ARRAY[p_outcome], ARRAY[p_version],
    ARRAY[p_confidence], ARRAY[p_reason], ARRAY[CASE WHEN p_outcome = 1 THEN 'rule' END],
    p_evaluated_at, 1::smallint, p_source_id, 'test_user'
  )
$$;

CREATE FUNCTION pg_temp.versions(p_account bigint) RETURNS text LANGUAGE sql AS $$
  SELECT versions::text FROM "AccountLabelState" WHERE "accountId" = p_account
$$;
CREATE FUNCTION pg_temp.rev(p_account bigint) RETURNS integer LANGUAGE sql AS $$
  SELECT rev FROM "AccountLabelState" WHERE "accountId" = p_account
$$;
CREATE FUNCTION pg_temp.changes(p_account bigint, p_type text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM "AccountLabelChange" WHERE "accountId" = p_account AND "changeType"::text = p_type
$$;

INSERT INTO "LabelDefinition" (key, description)
VALUES ('label_a', '検証用 A'), ('label_b', '検証用 B'), ('label_c', '検証用 C');

-- T1: true の upsert。新規アカウント (状態行なし) は rev = 0 で渡せる。
SELECT pg_temp.expect(pg_temp.put(1001, 1::smallint, 0, 1::smallint, 1::smallint, 0.9, 'reason one') = ARRAY[]::bigint[],
  'T1 first write is applied');
SELECT pg_temp.expect(pg_temp.rev(1001) = 1 AND pg_temp.versions(1001) = '{1}', 'T1 state after first write');
SELECT pg_temp.expect(
  (SELECT count(*) FROM "AccountActiveLabel"
   WHERE "accountId" = 1001 AND "labelDefinitionId" = 1 AND "ruleVersionNo" = 1 AND "confidence" = 0.9
     AND "reason" = 'reason one' AND "method" = 'rule' AND "sourceKind" = 1
     AND "sourceId" = 'run' AND "sourceUsername" = 'test_user') = 1,
  'T1 active label row');
SELECT pg_temp.expect(pg_temp.changes(1001, 'added') = 1, 'T1 added is recorded once');

-- T2: 同じ内容の再評価。rev は進むが、行は更新されず、変更も記録されない。
CREATE TEMP TABLE t2_before AS
  SELECT "labeledAt", xmin::text AS row_xmin FROM "AccountActiveLabel" WHERE "accountId" = 1001;
SELECT pg_temp.expect(pg_temp.put(1001, 1::smallint, 1, 1::smallint, 1::smallint, 0.9, 'reason one',
  now() + interval '1 hour') = ARRAY[]::bigint[], 'T2 write is applied');
SELECT pg_temp.expect(pg_temp.rev(1001) = 2, 'T2 rev increments even without change');
SELECT pg_temp.expect(
  (SELECT a.xmin::text = b.row_xmin AND a."labeledAt" = b."labeledAt"
   FROM "AccountActiveLabel" a, t2_before b WHERE a."accountId" = 1001),
  'T2 unchanged label row is not rewritten');
SELECT pg_temp.expect(pg_temp.changes(1001, 'added') = 1, 'T2 no extra change row');

-- T3: confidence だけの変化。行は更新されるが、値は true のままなので変更は記録されない。
SELECT pg_temp.expect(pg_temp.put(1001, 1::smallint, 2, 1::smallint, 1::smallint, 0.5, 'reason one') = ARRAY[]::bigint[],
  'T3 write is applied');
SELECT pg_temp.expect(
  (SELECT confidence FROM "AccountActiveLabel" WHERE "accountId" = 1001) = 0.5
  AND (SELECT count(*) FROM "AccountLabelChange" WHERE "accountId" = 1001) = 1,
  'T3 confidence-only update records nothing');

-- T4: 評価済みで false。true の行を削除し、removed を記録する。changedAt は評価時刻、sourceId は呼び出し元の値。
SELECT pg_temp.expect(
  pg_temp.put(1001, 1::smallint, 3, 0::smallint, 2::smallint, NULL, NULL,
              timestamptz '2026-01-02 03:04:05.678+00', 'run_false') = ARRAY[]::bigint[],
  'T4 write is applied');
SELECT pg_temp.expect(pg_temp.versions(1001) = '{2}', 'T4 versions is positive for evaluated false');
SELECT pg_temp.expect(NOT EXISTS (SELECT 1 FROM "AccountActiveLabel" WHERE "accountId" = 1001), 'T4 row deleted');
SELECT pg_temp.expect(
  (SELECT count(*) FROM "AccountLabelChange"
   WHERE "accountId" = 1001 AND "changeType" = 'removed' AND "previousValue" IS TRUE AND "newValue" IS FALSE
     AND "previousConfidence" = 0.5 AND "previousReason" = 'reason one' AND "newConfidence" IS NULL
     AND "sourceId" = 'run_false' AND "changedAt" = timestamptz '2026-01-02 03:04:05.678+00') = 1,
  'T4 removed change row');
-- false が続いても、行が無いので何も記録されない。
SELECT pg_temp.expect(pg_temp.put(1001, 1::smallint, 4, 0::smallint, 2::smallint) = ARRAY[]::bigint[], 'T4 repeat');
SELECT pg_temp.expect(pg_temp.changes(1001, 'removed') = 1, 'T4 repeated false records nothing');

-- T5: true から評価不能。versions は負になり、行は削除され、unevaluable が記録される。
SELECT pg_temp.expect(pg_temp.put(1001, 1::smallint, 5, 1::smallint, 3::smallint, 0.7, 'again') = ARRAY[]::bigint[],
  'T5 true again');
SELECT pg_temp.expect(pg_temp.changes(1001, 'added') = 2 AND pg_temp.versions(1001) = '{3}', 'T5 added again');
SELECT pg_temp.expect(
  pg_temp.put(1001, 1::smallint, 6, (-1)::smallint, 3::smallint, NULL, NULL,
              timestamptz '2026-02-03 04:05:06.789+00', 'run_unevaluable') = ARRAY[]::bigint[],
  'T5 unevaluable write is applied');
SELECT pg_temp.expect(pg_temp.versions(1001) = '{-3}', 'T5 versions is negative for unevaluable');
SELECT pg_temp.expect(NOT EXISTS (SELECT 1 FROM "AccountActiveLabel" WHERE "accountId" = 1001), 'T5 row deleted');
SELECT pg_temp.expect(
  (SELECT count(*) FROM "AccountLabelChange"
   WHERE "accountId" = 1001 AND "changeType" = 'unevaluable' AND "previousValue" IS TRUE AND "newValue" IS NULL
     AND "previousConfidence" = 0.7 AND "previousReason" = 'again'
     AND "sourceId" = 'run_unevaluable' AND "changedAt" = timestamptz '2026-02-03 04:05:06.789+00') = 1,
  'T5 unevaluable change row');
SELECT pg_temp.expect(pg_temp.changes(1001, 'removed') = 1, 'T5 unevaluable is not recorded as removed');

-- T6: 行が無いラベルが評価不能になっても、何も記録されない。
SELECT pg_temp.expect(pg_temp.put(1001, 2::smallint, 7, (-1)::smallint, 1::smallint) = ARRAY[]::bigint[], 'T6 write');
SELECT pg_temp.expect(pg_temp.versions(1001) = '{-3,-1}', 'T6 versions extends with the new label');
SELECT pg_temp.expect(pg_temp.changes(1001, 'unevaluable') = 1, 'T6 no change for a label without a row');

-- T7: rev の不一致。戻り値で返し、何も書かない。
CREATE TEMP TABLE t7_before AS
  SELECT (SELECT count(*) FROM "AccountLabelChange") AS changes, pg_temp.rev(1001) AS rev, pg_temp.versions(1001) AS versions;
SELECT pg_temp.expect(pg_temp.put(1001, 1::smallint, 3, 1::smallint, 9::smallint, 0.99, 'stale') = ARRAY[1001]::bigint[],
  'T7 stale write is reported as a miss');
SELECT pg_temp.expect(
  (SELECT b.changes = (SELECT count(*) FROM "AccountLabelChange") AND b.rev = pg_temp.rev(1001)
          AND b.versions = pg_temp.versions(1001) FROM t7_before b)
  AND NOT EXISTS (SELECT 1 FROM "AccountActiveLabel" WHERE "accountId" = 1001),
  'T7 stale write leaves state, labels and audit untouched');

-- T8: ラベルを後から追加しても既存の状態行は書き換えず、書き込み時に 0 で伸ばす。
INSERT INTO "LabelDefinition" (key, description) VALUES ('label_d', '検証用 D'), ('label_e', '検証用 E');
SELECT pg_temp.expect(pg_temp.put(1002, 1::smallint, 0, 1::smallint, 1::smallint, 0.8, 'short') = ARRAY[]::bigint[], 'T8 write 1');
SELECT pg_temp.expect(pg_temp.versions(1002) = '{1}', 'T8 short array');
SELECT pg_temp.expect(pg_temp.put(1002, 5::smallint, 1, 1::smallint, 4::smallint, 0.6, 'wide') = ARRAY[]::bigint[], 'T8 write 5');
SELECT pg_temp.expect(pg_temp.versions(1002) = '{1,0,0,0,4}', 'T8 gaps are filled with zero (unevaluated)');

-- T9: 複数アカウントを 1 回で渡す。rev が古いアカウントだけが戻り、他は反映される。
SELECT pg_temp.expect(
  set_label_result(
    ARRAY[1003, 1003, 1002, 1004]::bigint[], ARRAY[1, 2, 1, 3]::smallint[], ARRAY[0, 0, 99, 0],
    ARRAY[1, 0, 1, -1]::smallint[], ARRAY[1, 1, 1, 2]::smallint[], ARRAY[0.4, NULL, 0.4, NULL]::float8[],
    ARRAY['m1', NULL, 'm2', NULL], ARRAY['rule', NULL, 'rule', NULL],
    now(), 2::smallint, 'run_multi', NULL
  ) = ARRAY[1002]::bigint[],
  'T9 only the stale account is reported');
SELECT pg_temp.expect(
  pg_temp.versions(1003) = '{1,1}' AND pg_temp.versions(1004) = '{0,0,-2}' AND pg_temp.rev(1002) = 2,
  'T9 other accounts are applied and the stale one is untouched');
SELECT pg_temp.expect(
  (SELECT "sourceKind" FROM "AccountActiveLabel" WHERE "accountId" = 1003) = 2
  AND (SELECT "sourceUsername" FROM "AccountActiveLabel" WHERE "accountId" = 1003) IS NULL,
  'T9 source kind and username are stored');

-- T10: 不正な入力は例外にする。
DO $$
DECLARE
  v_cases text[] := ARRAY[
    -- 配列長の不一致
    $c$SELECT set_label_result(ARRAY[1,2]::bigint[], ARRAY[1]::smallint[], ARRAY[0,0], ARRAY[1,1]::smallint[], ARRAY[1,1]::smallint[], ARRAY[0.5,0.5]::float8[], ARRAY['a','a'], ARRAY['rule','rule'], now(), 1::smallint, 'x', NULL)$c$,
    -- 同じアカウントとラベルの重複
    $c$SELECT set_label_result(ARRAY[1,1]::bigint[], ARRAY[1,1]::smallint[], ARRAY[0,0], ARRAY[1,1]::smallint[], ARRAY[1,1]::smallint[], ARRAY[0.5,0.5]::float8[], ARRAY['a','a'], ARRAY['rule','rule'], now(), 1::smallint, 'x', NULL)$c$,
    -- 同じアカウントで expected rev が食い違う
    $c$SELECT set_label_result(ARRAY[1,1]::bigint[], ARRAY[1,2]::smallint[], ARRAY[0,1], ARRAY[0,0]::smallint[], ARRAY[1,1]::smallint[], ARRAY[NULL,NULL]::float8[], ARRAY[NULL,NULL], ARRAY[NULL,NULL], now(), 1::smallint, 'x', NULL)$c$,
    -- outcome の範囲外
    $c$SELECT set_label_result(ARRAY[1]::bigint[], ARRAY[1]::smallint[], ARRAY[0], ARRAY[2]::smallint[], ARRAY[1]::smallint[], ARRAY[NULL]::float8[], ARRAY[NULL], ARRAY[NULL], now(), 1::smallint, 'x', NULL)$c$,
    -- versionNo 0 は予約値
    $c$SELECT set_label_result(ARRAY[1]::bigint[], ARRAY[1]::smallint[], ARRAY[0], ARRAY[0]::smallint[], ARRAY[0]::smallint[], ARRAY[NULL]::float8[], ARRAY[NULL], ARRAY[NULL], now(), 1::smallint, 'x', NULL)$c$,
    -- true なのに confidence がない
    $c$SELECT set_label_result(ARRAY[1]::bigint[], ARRAY[1]::smallint[], ARRAY[0], ARRAY[1]::smallint[], ARRAY[1]::smallint[], ARRAY[NULL]::float8[], ARRAY['a'], ARRAY['rule'], now(), 1::smallint, 'x', NULL)$c$,
    -- 存在しない label_id
    $c$SELECT set_label_result(ARRAY[1]::bigint[], ARRAY[999]::smallint[], ARRAY[0], ARRAY[0]::smallint[], ARRAY[1]::smallint[], ARRAY[NULL]::float8[], ARRAY[NULL], ARRAY[NULL], now(), 1::smallint, 'x', NULL)$c$,
    -- アカウント ID の配列が NULL
    $c$SELECT set_label_result(NULL, ARRAY[1]::smallint[], ARRAY[0], ARRAY[0]::smallint[], ARRAY[1]::smallint[], ARRAY[NULL]::float8[], ARRAY[NULL], ARRAY[NULL], now(), 1::smallint, 'x', NULL)$c$
  ];
  v_expected text[] := ARRAY[
    'array lengths differ',
    'duplicate label or inconsistent expected rev for an account',
    'duplicate label or inconsistent expected rev for an account',
    'invalid input row',
    'invalid input row',
    'invalid input row',
    'unknown label id',
    'account ids are required'
  ];
  v_case text;
  v_failed boolean;
  v_message text;
BEGIN
  FOR i IN 1..cardinality(v_cases) LOOP
    v_case := v_cases[i];
    v_failed := false;
    BEGIN
      EXECUTE v_case;
    EXCEPTION WHEN OTHERS THEN
      v_failed := true;
      v_message := SQLERRM;
    END;
    IF NOT v_failed THEN
      RAISE EXCEPTION 'behavior check failed: T10 invalid input was accepted: %', v_case;
    END IF;
    IF v_message <> 'set_label_result: ' || v_expected[i] THEN
      RAISE EXCEPTION 'behavior check failed: T10 case % raised "%" instead of "%"', i, v_message, v_expected[i];
    END IF;
  END LOOP;
END
$$;
SELECT pg_temp.expect(NOT EXISTS (SELECT 1 FROM "AccountLabelState" WHERE "accountId" IN (1, 2)),
  'T10 rejected input leaves no state rows');

-- T11: 空の入力は何もせず、空の配列を返す。
SELECT pg_temp.expect(
  set_label_result(ARRAY[]::bigint[], ARRAY[]::smallint[], ARRAY[]::integer[], ARRAY[]::smallint[], ARRAY[]::smallint[],
                   ARRAY[]::float8[], ARRAY[]::text[], ARRAY[]::text[], now(), 1::smallint, NULL, NULL) = ARRAY[]::bigint[],
  'T11 empty input');

-- T11b: 状態行が無いのに rev が 0 でないアカウントは、行を作らずに未反映として返す。
SELECT pg_temp.expect(pg_temp.put(1007, 1::smallint, 5, 1::smallint, 1::smallint, 0.5, 'x') = ARRAY[1007]::bigint[],
  'T11b a missing state row with a non-zero expected rev is reported as a miss');
SELECT pg_temp.expect(
  NOT EXISTS (SELECT 1 FROM "AccountLabelState" WHERE "accountId" = 1007)
  AND NOT EXISTS (SELECT 1 FROM "AccountActiveLabel" WHERE "accountId" = 1007),
  'T11b no empty state row is left behind');

-- T12: set_label_result を経由しない直接の DELETE (所有者権限) でも、トリガーが removed を記録する。
SELECT pg_temp.expect(pg_temp.put(1005, 1::smallint, 0, 1::smallint, 1::smallint, 0.3, 'direct') = ARRAY[]::bigint[], 'T12 setup');
DELETE FROM "AccountActiveLabel" WHERE "accountId" = 1005;
SELECT pg_temp.expect(pg_temp.changes(1005, 'removed') = 1 AND pg_temp.changes(1005, 'added') = 1,
  'T12 direct delete is audited');
SELECT pg_temp.expect(
  (SELECT "sourceId" FROM "AccountLabelChange" WHERE "accountId" = 1005 AND "changeType" = 'removed') IS NULL,
  'T12 direct delete has no stale source id from an earlier call');

-- T13: トランザクションローカルな設定が、呼び出し後に残らない。
BEGIN;
SELECT pg_temp.put(1006, 1::smallint, 0, 1::smallint, 1::smallint, 0.2, 'tx');
SELECT pg_temp.put(1006, 1::smallint, 1, 0::smallint, 1::smallint);
SELECT pg_temp.expect(
  coalesce(current_setting('app.removal_kind', true), '') = ''
  AND coalesce(current_setting('app.source_id', true), '') = ''
  AND coalesce(current_setting('app.labeled_at', true), '') = '',
  'T13 settings are cleared');
COMMIT;

-- T14: 不変条件。versions が正で行があれば true、行がなければ false、負なら行を持たない。
SELECT pg_temp.expect(
  NOT EXISTS (
    SELECT 1
    FROM "AccountLabelState" s
    JOIN "AccountActiveLabel" a ON a."accountId" = s."accountId"
    WHERE COALESCE(s.versions[a."labelDefinitionId"], 0) <= 0
       OR s.versions[a."labelDefinitionId"] <> a."ruleVersionNo"
  ),
  'T14 every active label row has a matching positive version');
SELECT pg_temp.expect(NOT EXISTS (SELECT 1 FROM "AccountLabelState" WHERE array_position(versions, NULL) IS NOT NULL),
  'T14 versions never contain NULL');

\o
SELECT 'behavior checks passed' AS result;
