-- analyzer の権限が allowlist 方式 (正本は SELECT のみ、分析・read model は write 可) に
-- 一致することを、データを書き換えず検証する。
-- psql で対象 DB へ接続し、このファイルを実行する。条件違反時は例外で終了する。

DO $$
DECLARE
  unreadable_tables text;
  unexpected_write_tables text;
  write_allowlist text[] := ARRAY[
    'AnalysisWorkItem', 'AnalysisRun',
    'OperationCycle', 'OperationStage', 'OperationalIssue', 'OperationalIssueOccurrence',
    'ReviewFinding', 'ReviewFindingOccurrence', 'FindingEvidence', 'FindingRawArtifact',
    'FindingEntityLink', 'DetectionPolicyVersion', 'DetectorEvaluation',
    'PolicyBacktestRun', 'PolicyBacktestFinding',
    'LabelMetricSnapshot', 'LabelMetricDaily',
    'AccountLabelChange',
    'AccountSummaryLatest', 'AccountClassificationLatest', 'ReadModelBootstrap',
    'LabelSummaryCurrent', 'BlockRelationCurrent', 'BlockStateChange',
    'AttentionItemCurrent', 'OverviewSnapshot',
    'ReadModelGeneration', 'ReadModelPointer', 'ReadModelState', 'DetectorState',
    'AccountClassificationValueCount', 'AccountClassificationConfidenceBucketCount',
    'AccountClassificationRuleVersionCount', 'AccountClassificationFreshnessBucket',
    'AccountClassificationReasonCount'
  ];
  limited_write_allowlist text[] := ARRAY['ComponentBuildIdentity'];
  update_only_allowlist text[] := ARRAY['LabeledAccountCounter'];
  missing_writes text;
  missing_limited_writes text;
  missing_update_only text;
  unexpected_limited_deletes text;
  unexpected_update_only_writes text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analyzer') THEN
    RAISE EXCEPTION 'role analyzer does not exist';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'analyzer'
      AND 'client_connection_check_interval=5s' = ANY(COALESCE(rolconfig, ARRAY[]::text[]))
  ) THEN
    RAISE EXCEPTION 'analyzer client_connection_check_interval must be 5s';
  END IF;

  IF NOT has_database_privilege('analyzer', current_database(), 'CONNECT') THEN
    RAISE EXCEPTION 'analyzer lacks CONNECT on database %', current_database();
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
  INTO unreadable_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND NOT has_table_privilege(
      'analyzer', format('%I.%I', n.nspname, c.relname), 'SELECT'
    );

  IF unreadable_tables IS NOT NULL THEN
    RAISE EXCEPTION 'analyzer lacks SELECT on: %', unreadable_tables;
  END IF;

  SELECT string_agg(t, ', ')
  INTO missing_writes
  FROM unnest(write_allowlist) AS t
  WHERE to_regclass(format('public.%I', t)) IS NOT NULL
    AND NOT has_table_privilege(
      'analyzer', format('public.%I', t), 'INSERT, UPDATE, DELETE'
    );

  IF missing_writes IS NOT NULL THEN
    RAISE EXCEPTION 'analyzer lacks INSERT/UPDATE/DELETE on allowlisted tables: %', missing_writes;
  END IF;

  SELECT string_agg(t, ', ')
  INTO missing_limited_writes
  FROM unnest(limited_write_allowlist) AS t
  WHERE to_regclass(format('public.%I', t)) IS NOT NULL
    AND NOT has_table_privilege(
      'analyzer', format('public.%I', t), 'INSERT, UPDATE'
    );

  IF missing_limited_writes IS NOT NULL THEN
    RAISE EXCEPTION 'analyzer lacks INSERT/UPDATE on limited-write tables: %',
      missing_limited_writes;
  END IF;

  SELECT string_agg(t, ', ')
  INTO unexpected_limited_deletes
  FROM unnest(limited_write_allowlist) AS t
  WHERE to_regclass(format('public.%I', t)) IS NOT NULL
    AND has_table_privilege('analyzer', format('public.%I', t), 'DELETE');

  IF unexpected_limited_deletes IS NOT NULL THEN
    RAISE EXCEPTION 'analyzer has unexpected DELETE on limited-write tables: %',
      unexpected_limited_deletes;
  END IF;

  SELECT string_agg(t, ', ')
  INTO missing_update_only
  FROM unnest(update_only_allowlist) AS t
  WHERE to_regclass(format('public.%I', t)) IS NOT NULL
    AND NOT has_table_privilege(
      'analyzer', format('public.%I', t), 'UPDATE'
    );

  IF missing_update_only IS NOT NULL THEN
    RAISE EXCEPTION 'analyzer lacks UPDATE on update-only tables: %',
      missing_update_only;
  END IF;

  SELECT string_agg(t, ', ')
  INTO unexpected_update_only_writes
  FROM unnest(update_only_allowlist) AS t
  WHERE to_regclass(format('public.%I', t)) IS NOT NULL
    AND has_table_privilege(
      'analyzer', format('public.%I', t),
      'INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER'
    );

  IF unexpected_update_only_writes IS NOT NULL THEN
    RAISE EXCEPTION 'analyzer has unexpected non-UPDATE writes on update-only tables: %',
      unexpected_update_only_writes;
  END IF;

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
  INTO unexpected_write_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND NOT (c.relname = ANY (write_allowlist))
    AND NOT (c.relname = ANY (limited_write_allowlist))
    AND NOT (c.relname = ANY (update_only_allowlist))
    AND has_table_privilege(
      'analyzer',
      format('%I.%I', n.nspname, c.relname),
      'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
    );

  IF unexpected_write_tables IS NOT NULL THEN
    RAISE EXCEPTION 'analyzer has write privileges on non-allowlisted tables: %',
      unexpected_write_tables;
  END IF;

  DECLARE
    unexpected_sequence_privileges text;
  BEGIN
    SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
    INTO unexpected_sequence_privileges
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND (
        has_sequence_privilege('analyzer', format('%I.%I', n.nspname, c.relname), 'USAGE')
        OR has_sequence_privilege('analyzer', format('%I.%I', n.nspname, c.relname), 'SELECT')
      );

    IF unexpected_sequence_privileges IS NOT NULL THEN
      RAISE EXCEPTION 'analyzer has unexpected sequence privileges on: %',
        unexpected_sequence_privileges;
    END IF;
  END;
END
$$;

SELECT 'analyzer grants verified' AS result;
