-- 補足: このマイグレーションを prisma migrate dev で生成すると、
-- 20260804110000_compact_account_label_history が安全網として意図的に残した
-- "AccountLabel_pre_compaction" テーブル (schema.prisma には未宣言) を
-- 削除する DDL が自動生成される。それは本タスクの変更対象ではなく、
-- 安全網テーブルを意図せず失う破壊的変更になるため、生成後に手動で除去している。

-- CreateTable
CREATE TABLE "AnalysisWorkItem" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "dependencyKey" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalysisWorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalysisRun" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "errorSummary" TEXT,

    CONSTRAINT "AnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnalysisWorkItem_status_availableAt_priority_idx" ON "AnalysisWorkItem"("status", "availableAt", "priority");

-- CreateIndex
CREATE UNIQUE INDEX "AnalysisWorkItem_kind_triggerType_triggerId_key" ON "AnalysisWorkItem"("kind", "triggerType", "triggerId");

-- CreateIndex
CREATE INDEX "AnalysisRun_workItemId_startedAt_idx" ON "AnalysisRun"("workItemId", "startedAt" DESC);

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "AnalysisWorkItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
