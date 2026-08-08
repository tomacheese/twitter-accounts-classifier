-- 補足: 20260806233641_add_analysis_work_item と同じ理由により、
-- 自動生成された "AccountLabel_pre_compaction" (安全網テーブル) への DROP DDL を除去している。
-- また "AccountSummaryCurrent_normalizedDisplayName_trgm_idx" (raw SQL で追加した
-- pg_trgm インデックス) は schema.prisma の DSL では表現できず prisma の追跡対象外のため、
-- 自動生成された誤った DROP INDEX も同様に除去している。

-- AlterTable
ALTER TABLE "AccountLabel" ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceKind" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "sourceUsername" TEXT;

-- AlterTable
ALTER TABLE "AccountLabelLatest" ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceKind" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "sourceUsername" TEXT;

-- AlterTable
ALTER TABLE "Block" ADD COLUMN     "consecutiveMissingCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "missingSinceAt" TIMESTAMP(3),
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceKind" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- CreateIndex
CREATE INDEX "AccountLabel_labeledAt_id_idx" ON "AccountLabel"("labeledAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AccountLabel_labelDefinitionId_labeledAt_id_idx" ON "AccountLabel"("labelDefinitionId", "labeledAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AccountLabel_sourceKind_sourceId_idx" ON "AccountLabel"("sourceKind", "sourceId");

-- CreateIndex
CREATE INDEX "Block_status_lastCheckedAt_idx" ON "Block"("status", "lastCheckedAt" DESC);
