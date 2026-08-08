-- 補足: 20260806233641_add_analysis_work_item と同じ理由により、
-- 自動生成された "AccountLabel_pre_compaction" (安全網テーブル) への DROP DDL を除去している。

-- CreateTable
CREATE TABLE "OperationCycle" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL,
    "expectedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "attentionRequired" BOOLEAN NOT NULL DEFAULT false,
    "currentStageKey" TEXT,
    "sourceWatermarkAt" TIMESTAMP(3),
    "modelVersion" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OperationCycle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationStage" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "stageKey" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "requiredness" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'waiting',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "sourceType" TEXT,
    "sourceId" TEXT,
    "expectedAt" TIMESTAMP(3),
    "delayedAt" TIMESTAMP(3),
    "staleAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "counters" JSONB NOT NULL DEFAULT '{}',
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "analysisRunId" TEXT,

    CONSTRAINT "OperationStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalIssue" (
    "id" TEXT NOT NULL,
    "component" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "severity" TEXT NOT NULL,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "currentOccurrenceId" TEXT,
    "sourceCycleId" TEXT,
    "sourceStageId" TEXT,

    CONSTRAINT "OperationalIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OperationalIssueOccurrence" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stateTransition" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "measurements" JSONB NOT NULL DEFAULT '{}',
    "observationKey" TEXT NOT NULL,

    CONSTRAINT "OperationalIssueOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OperationCycle_kind_startedAt_id_idx" ON "OperationCycle"("kind", "startedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "OperationCycle_attentionRequired_status_idx" ON "OperationCycle"("attentionRequired", "status");

-- CreateIndex
CREATE UNIQUE INDEX "OperationCycle_sourceType_sourceId_key" ON "OperationCycle"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "OperationStage_cycleId_sequence_idx" ON "OperationStage"("cycleId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "OperationStage_cycleId_stageKey_key" ON "OperationStage"("cycleId", "stageKey");

-- CreateIndex
CREATE INDEX "OperationalIssue_status_severity_lastDetectedAt_id_idx" ON "OperationalIssue"("status", "severity", "lastDetectedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "OperationalIssue_fingerprint_key" ON "OperationalIssue"("fingerprint");

-- CreateIndex
CREATE INDEX "OperationalIssueOccurrence_issueId_observedAt_id_idx" ON "OperationalIssueOccurrence"("issueId", "observedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "OperationalIssueOccurrence_issueId_observationKey_key" ON "OperationalIssueOccurrence"("issueId", "observationKey");

-- AddForeignKey
ALTER TABLE "OperationStage" ADD CONSTRAINT "OperationStage_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "OperationCycle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperationalIssueOccurrence" ADD CONSTRAINT "OperationalIssueOccurrence_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "OperationalIssue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
