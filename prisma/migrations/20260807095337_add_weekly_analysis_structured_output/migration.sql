-- 補足: 20260806233641_add_analysis_work_item と同じ理由により、
-- 自動生成された "AccountLabel_pre_compaction" (安全網テーブル) への DROP DDL、
-- "AccountSummaryCurrent_normalizedDisplayName_trgm_idx" (raw SQL で追加した
-- pg_trgm インデックス) への誤った DROP INDEX、および Postgres の識別子長制限
-- (63 バイト) による無関係なインデックス名の揺れに起因する RENAME INDEX を除去している。

-- AlterTable
ALTER TABLE "WeeklyAnalysisRun" ADD COLUMN     "analysisVersion" TEXT,
ADD COLUMN     "modelIdentity" TEXT,
ADD COLUMN     "policyHash" TEXT,
ADD COLUMN     "structuredOutput" JSONB,
ADD COLUMN     "targetFrom" TIMESTAMP(3),
ADD COLUMN     "targetTo" TIMESTAMP(3),
ADD COLUMN     "toolIdentity" TEXT;
