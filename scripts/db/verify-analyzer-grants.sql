-- analyzer の権限が allowlist 方式 (正本はSELECTのみ、分析・read modelはwrite可) に
-- 一致することを、データを書き換えず検証する。
-- psql で対象DBへ接続し、このファイルを実行する。条件違反時は例外で終了する。

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
    'AccountSummaryCurrent', 'AccountClassificationCurrent', 'AccountLabelChange',
    'LabelSummaryCurrent', 'BlockRelationCurrent', 'BlockStateChange',
    'AttentionItemCurrent', 'OverviewSnapshot',
    'ReadModelGeneration', 'ReadModelPointer', 'ReadModelState'
  ];
  missing_writes text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analyzer') THEN
    RAISE EXCEPTION 'role analyzer does not exist';
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

  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
  INTO unexpected_write_tables
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND NOT (c.relname = ANY (write_allowlist))
    AND has_table_privilege(
      'analyzer',
      format('%I.%I', n.nspname, c.relname),
      'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
    );

  IF unexpected_write_tables IS NOT NULL THEN
    RAISE EXCEPTION 'analyzer has write privileges on non-allowlisted tables: %',
      unexpected_write_tables;
  END IF;
END
$$;

SELECT 'analyzer grants verified' AS result;
