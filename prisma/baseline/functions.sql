-- ラベル保存の書き込み関数と、AccountActiveLabel の監査トリガー。baseline.sql の後 (Tweet の DDL の後) に適用する。
--
-- AccountLabelState と AccountActiveLabel への書き込みは、関数 set_label_result だけに閉じる。
-- アプリ用ロールからは両表への直接の INSERT/UPDATE/DELETE を REVOKE し、
-- set_label_result (SECURITY DEFINER) の EXECUTE だけを与える。
-- これにより、監査トリガーを迂回する書き込みを権限で拒否する。
-- 権限が効くのは、アプリ用ロールがスーパーユーザーでも BYPASSRLS でもなく、両表の所有者でもない場合に限る。
-- アプリ用ロールが所有者の場合は、その所有者自身の DML 権限が REVOKE で外れるだけで、GRANT で戻せてしまう。
--
-- 呼び出し側の前提:
-- - READ COMMITTED で呼ぶ。ロック待ち後に最新の行で rev を比較する動作に依存する。
-- - 評価入力を読んだ時点の rev を、そのアカウントの全行の p_expected_revs に入れる。
--   状態行がまだ無いアカウントは 0 を渡す。
-- - 戻り値は rev の比較に失敗した (別の書き込みが先に入った) アカウントの ID の配列で、
--   空なら全アカウントを反映済み。呼び出し側は入力を読み直して再評価し、再試行は回数に上限を設ける。

-- ============================================================
-- 監査トリガー
-- ============================================================

-- AccountActiveLabel の変化を AccountLabelChange へ記録する。
-- INSERT は added、DELETE は removed (評価が false になった) か unevaluable (true から評価不能になった) を記録する。
-- DELETE には NEW がないため、変更の時刻、元、種別は set_label_result が set_config で渡す。
-- 値が true のまま confidence や reason だけが変わる UPDATE は、旧実装と同じく記録しない。
CREATE FUNCTION account_active_label_change_audit() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_kind text;
  v_source_id text;
  v_changed_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "AccountLabelChange"
      ("accountId", "labelDefinitionId", "changeType", "previousValue", "newValue",
       "previousConfidence", "newConfidence", "previousReason", "newReason", "sourceId", "changedAt")
    VALUES
      (NEW."accountId", NEW."labelDefinitionId", 'added', NULL, true,
       NULL, NEW."confidence", NULL, NEW."reason", NEW."sourceId", NEW."labeledAt");
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    v_kind := CASE current_setting('app.removal_kind', true)
      WHEN 'unevaluable' THEN 'unevaluable'
      ELSE 'removed'
    END;
    v_source_id := nullif(current_setting('app.source_id', true), '');
    v_changed_at := COALESCE(nullif(current_setting('app.labeled_at', true), '')::timestamptz, now());
    INSERT INTO "AccountLabelChange"
      ("accountId", "labelDefinitionId", "changeType", "previousValue", "newValue",
       "previousConfidence", "newConfidence", "previousReason", "newReason", "sourceId", "changedAt")
    VALUES
      (OLD."accountId", OLD."labelDefinitionId", v_kind::"AccountLabelChangeType", true,
       CASE v_kind WHEN 'removed' THEN false ELSE NULL END,
       OLD."confidence", NULL, OLD."reason", NULL, v_source_id, v_changed_at);
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER account_active_label_change_audit_trigger
  AFTER INSERT OR UPDATE OR DELETE ON "AccountActiveLabel"
  FOR EACH ROW EXECUTE FUNCTION account_active_label_change_audit();

-- ============================================================
-- 書き込み関数
-- ============================================================

-- 複数アカウントの評価結果を、(アカウント, ラベル) 単位の並列配列で受け取る。
-- 配列の i 番目が 1 行分で、全配列の長さは同じでなければならない。
--   p_outcomes: 1 = true、0 = 評価済みで false、-1 = 評価不能
--   p_version_nos: ルールの versionNo (1 以上)。全 outcome で必須
--   p_confidences、p_reasons、p_methods: outcome = 1 のときだけ使う
--   p_source_kind: 0 = legacy、1 = crawl、2 = relabel
-- AccountLabelState.versions は、true と false を +versionNo、評価不能を -versionNo にする。
-- 配列が短い既存行は、足りない添字を 0 (未評価) として伸ばす。
-- 評価不能への遷移は、true の行を削除して unevaluable として記録する。行が無かった場合は記録しない。
CREATE FUNCTION set_label_result(
  p_account_ids bigint[],
  p_label_ids smallint[],
  p_expected_revs integer[],
  p_outcomes smallint[],
  p_version_nos smallint[],
  p_confidences double precision[],
  p_reasons text[],
  p_methods text[],
  p_evaluated_at timestamptz,
  p_source_kind smallint,
  p_source_id text,
  p_source_username text
) RETURNS bigint[]
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_n integer := COALESCE(cardinality(p_account_ids), 0);
  v_applied bigint[];
  v_missed bigint[];
BEGIN
  IF v_n = 0 THEN
    RETURN ARRAY[]::bigint[];
  END IF;

  IF cardinality(p_label_ids) IS DISTINCT FROM v_n
    OR cardinality(p_expected_revs) IS DISTINCT FROM v_n
    OR cardinality(p_outcomes) IS DISTINCT FROM v_n
    OR cardinality(p_version_nos) IS DISTINCT FROM v_n
    OR cardinality(p_confidences) IS DISTINCT FROM v_n
    OR cardinality(p_reasons) IS DISTINCT FROM v_n
    OR cardinality(p_methods) IS DISTINCT FROM v_n
  THEN
    RAISE EXCEPTION 'set_label_result: array lengths differ';
  END IF;

  IF p_evaluated_at IS NULL OR p_source_kind IS NULL THEN
    RAISE EXCEPTION 'set_label_result: evaluated_at and source_kind are required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_account_ids, p_label_ids, p_expected_revs, p_outcomes, p_version_nos,
                p_confidences, p_reasons, p_methods)
      AS i(account_id, label_id, exp_rev, outcome, version_no, confidence, reason, method)
    WHERE i.account_id IS NULL OR i.label_id IS NULL OR i.label_id < 1
      OR i.exp_rev IS NULL OR i.exp_rev < 0
      OR i.outcome IS NULL OR i.outcome NOT IN (1, 0, -1)
      OR i.version_no IS NULL OR i.version_no < 1
      OR (i.outcome = 1 AND (i.confidence IS NULL OR i.reason IS NULL OR i.method IS NULL))
  ) THEN
    RAISE EXCEPTION 'set_label_result: invalid input row';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_account_ids, p_label_ids, p_expected_revs) AS i(account_id, label_id, exp_rev)
    GROUP BY i.account_id
    HAVING count(*) <> count(DISTINCT i.label_id) OR count(DISTINCT i.exp_rev) <> 1
  ) THEN
    RAISE EXCEPTION 'set_label_result: duplicate label or inconsistent expected rev for an account';
  END IF;

  -- 状態行がまだ無いアカウントは、rev = 0 の空の行を作る。
  -- 作った行は、同じトランザクション内で必ず rev を進めて反映するため、空のまま残らない。
  INSERT INTO "AccountLabelState" ("accountId", "evaluatedAt", "rev", "versions")
  SELECT d.account_id, p_evaluated_at, 0, ARRAY[]::smallint[]
  FROM (SELECT DISTINCT a AS account_id FROM unnest(p_account_ids) AS a) AS d
  ORDER BY d.account_id
  ON CONFLICT ("accountId") DO NOTHING;

  -- accountId の昇順で行ロックを取り、デッドロックを避ける。
  -- ロック待ちのあとは最新の行で rev を比べるため、CAS として成立する。
  SELECT
    COALESCE(array_agg(s."accountId" ORDER BY s."accountId") FILTER (WHERE s."rev" = e.exp_rev), ARRAY[]::bigint[]),
    COALESCE(array_agg(s."accountId" ORDER BY s."accountId") FILTER (WHERE s."rev" <> e.exp_rev), ARRAY[]::bigint[])
  INTO v_applied, v_missed
  FROM (
    SELECT "accountId", "rev"
    FROM "AccountLabelState"
    WHERE "accountId" = ANY (p_account_ids)
    ORDER BY "accountId"
    FOR UPDATE
  ) AS s
  JOIN (SELECT DISTINCT account_id, exp_rev FROM unnest(p_account_ids, p_expected_revs) AS x(account_id, exp_rev)) AS e
    ON e.account_id = s."accountId";

  IF cardinality(v_applied) = 0 THEN
    RETURN v_missed;
  END IF;

  -- 監査トリガーへ渡す変更の元と時刻。トランザクションローカルで、接続プールへ漏れない。
  PERFORM set_config('app.source_id', COALESCE(p_source_id, ''), true);
  PERFORM set_config('app.labeled_at', p_evaluated_at::text, true);

  -- 評価済みで false になったラベルの true 行を削除する (removed)。
  PERFORM set_config('app.removal_kind', 'removed', true);
  DELETE FROM "AccountActiveLabel" AS a
  USING unnest(p_account_ids, p_label_ids, p_outcomes) AS i(account_id, label_id, outcome)
  WHERE i.outcome = 0 AND i.account_id = ANY (v_applied)
    AND a."accountId" = i.account_id AND a."labelDefinitionId" = i.label_id;

  -- 評価不能になったラベルの true 行を削除する (unevaluable)。
  PERFORM set_config('app.removal_kind', 'unevaluable', true);
  DELETE FROM "AccountActiveLabel" AS a
  USING unnest(p_account_ids, p_label_ids, p_outcomes) AS i(account_id, label_id, outcome)
  WHERE i.outcome = -1 AND i.account_id = ANY (v_applied)
    AND a."accountId" = i.account_id AND a."labelDefinitionId" = i.label_id;

  PERFORM set_config('app.removal_kind', '', true);

  -- true の行を upsert する。内容が変わらないときは更新せず、不要な死んだ行を作らない。
  INSERT INTO "AccountActiveLabel"
    ("accountId", "labeledAt", "confidence", "labelDefinitionId", "ruleVersionNo", "sourceKind",
     "method", "reason", "sourceId", "sourceUsername")
  SELECT i.account_id, p_evaluated_at, i.confidence, i.label_id, i.version_no, p_source_kind,
         i.method, i.reason, p_source_id, p_source_username
  FROM unnest(p_account_ids, p_label_ids, p_outcomes, p_version_nos, p_confidences, p_reasons, p_methods)
    AS i(account_id, label_id, outcome, version_no, confidence, reason, method)
  WHERE i.outcome = 1 AND i.account_id = ANY (v_applied)
  ORDER BY i.account_id, i.label_id
  ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE SET
    "labeledAt" = EXCLUDED."labeledAt",
    "confidence" = EXCLUDED."confidence",
    "ruleVersionNo" = EXCLUDED."ruleVersionNo",
    "sourceKind" = EXCLUDED."sourceKind",
    "method" = EXCLUDED."method",
    "reason" = EXCLUDED."reason",
    "sourceId" = EXCLUDED."sourceId",
    "sourceUsername" = EXCLUDED."sourceUsername"
  WHERE ("AccountActiveLabel"."ruleVersionNo", "AccountActiveLabel"."confidence",
         "AccountActiveLabel"."reason", "AccountActiveLabel"."method")
    IS DISTINCT FROM (EXCLUDED."ruleVersionNo", EXCLUDED."confidence", EXCLUDED."reason", EXCLUDED."method");

  -- versions を伸ばして書き換え、rev を 1 進める。
  -- 添字は LabelDefinition.id。足りない添字は 0 (未評価) で埋める。
  WITH r AS (
    SELECT i.account_id, i.label_id,
           (CASE WHEN i.outcome = -1 THEN -i.version_no ELSE i.version_no END)::smallint AS signed_version
    FROM unnest(p_account_ids, p_label_ids, p_outcomes, p_version_nos)
      AS i(account_id, label_id, outcome, version_no)
    WHERE i.account_id = ANY (v_applied)
  ),
  lens AS (
    SELECT s."accountId" AS account_id, s."versions" AS old_versions,
           GREATEST(cardinality(s."versions"), m.max_label) AS len
    FROM "AccountLabelState" AS s
    JOIN (SELECT account_id, max(label_id) AS max_label FROM r GROUP BY account_id) AS m
      ON m.account_id = s."accountId"
  ),
  new_versions AS (
    SELECT l.account_id,
           array_agg(COALESCE(r.signed_version, l.old_versions[g], 0)::smallint ORDER BY g) AS versions
    FROM lens AS l
    CROSS JOIN LATERAL generate_series(1, l.len) AS g
    LEFT JOIN r ON r.account_id = l.account_id AND r.label_id = g
    GROUP BY l.account_id
  )
  UPDATE "AccountLabelState" AS s
  SET "versions" = n.versions, "rev" = s."rev" + 1, "evaluatedAt" = p_evaluated_at
  FROM new_versions AS n
  WHERE s."accountId" = n.account_id;

  PERFORM set_config('app.source_id', '', true);
  PERFORM set_config('app.labeled_at', '', true);

  RETURN v_missed;
END
$$;

-- ============================================================
-- 権限
-- ============================================================

REVOKE ALL ON FUNCTION set_label_result(
  bigint[], smallint[], integer[], smallint[], smallint[], double precision[], text[], text[],
  timestamptz, smallint, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION account_active_label_change_audit() FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "AccountLabelState", "AccountActiveLabel" FROM PUBLIC;

-- 既知のアプリ用ロールが存在するときだけ、直接の書き込み権限を外し、書き込み側にだけ関数の実行を許す。
-- 書き込み側は crawler ロール (crawler、relabeler、blocker が共用する)。
DO $$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['crawler', 'analyzer', 'viewer', 'weekly_review', 'blocker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      EXECUTE format(
        'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "AccountLabelState", "AccountActiveLabel" FROM %I',
        v_role
      );
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'crawler') THEN
    GRANT EXECUTE ON FUNCTION set_label_result(
      bigint[], smallint[], integer[], smallint[], smallint[], double precision[], text[], text[],
      timestamptz, smallint, text, text
    ) TO crawler;
  END IF;
END
$$;
