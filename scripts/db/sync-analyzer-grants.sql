-- analyzer は正本テーブルへ SELECT のみ、分析・read model テーブルへ INSERT/UPDATE/DELETE を持つ。
-- 正本テーブル (Account, Tweet, AccountLabel, AccountLabelLatest, Follow, CrawlRun,
-- CrawlAccountRun, CrawlAccountCheckpoint, CrawlAccountLabelRun, WeeklyAnalysisRun,
-- Block, BlockRun, BlockAccountRun, BlockAction, LabelDefinition, LabelingFollowSample)
-- は書き込ませない。

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'analyzer') THEN
    RAISE EXCEPTION 'role analyzer does not exist; create it before syncing grants';
  END IF;

  EXECUTE format(
    'GRANT CONNECT ON DATABASE %I TO analyzer',
    current_database()
  );
END
$$;

GRANT USAGE ON SCHEMA public TO analyzer;

ALTER ROLE analyzer SET client_connection_check_interval = '5s';


REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON ALL TABLES IN SCHEMA public
  FROM analyzer;
REVOKE ALL PRIVILEGES
  ON ALL SEQUENCES IN SCHEMA public
  FROM analyzer;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO analyzer;

-- 分析・運用・read model テーブルへの write allowlist。
GRANT INSERT, UPDATE, DELETE ON TABLE
  "AnalysisWorkItem", "AnalysisRun",
  "OperationCycle", "OperationStage", "OperationalIssue", "OperationalIssueOccurrence",
  "ReviewFinding", "ReviewFindingOccurrence", "FindingEvidence", "FindingRawArtifact",
  "FindingEntityLink", "DetectionPolicyVersion", "DetectorEvaluation",
  "PolicyBacktestRun", "PolicyBacktestFinding",
  "LabelMetricSnapshot", "LabelMetricDaily",
  "AccountLabelChange",
  "AccountSummaryLatest", "AccountClassificationLatest", "ReadModelBootstrap",
  "LabelSummaryCurrent", "BlockRelationCurrent", "BlockStateChange",
  "AttentionItemCurrent", "OverviewSnapshot",
  "ReadModelGeneration", "ReadModelPointer", "ReadModelState", "DetectorState",
  "AccountClassificationValueCount", "AccountClassificationConfidenceBucketCount",
  "AccountClassificationRuleVersionCount", "AccountClassificationFreshnessBucket"
  TO analyzer;

-- build identity は analyzer 自身の起動情報を upsert するため INSERT/UPDATE のみ許可する。
GRANT INSERT, UPDATE ON TABLE "ComponentBuildIdentity" TO analyzer;

-- 現行スキーマは autoincrement を使わずシーケンスを持たないため、schema 全体への
-- USAGE/SELECT は付与しない。write allowlist のテーブルがシーケンス列を持つに至った
-- 時点で、個別のシーケンスを名指しして GRANT を追加する。
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLES FROM analyzer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO analyzer;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM analyzer;

COMMIT;
