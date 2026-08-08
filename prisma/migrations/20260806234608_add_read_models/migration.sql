-- 補足: 20260806233641_add_analysis_work_item と同じ理由により、
-- 自動生成された "AccountLabel_pre_compaction" (安全網テーブル) への DROP DDL を除去している。

-- CreateTable
CREATE TABLE "LabelMetricSnapshot" (
    "id" TEXT NOT NULL,
    "sourceCrawlRunId" TEXT NOT NULL,
    "labelDefinitionId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceWatermarkAt" TIMESTAMP(3) NOT NULL,
    "evaluatedCount" INTEGER NOT NULL,
    "trueCount" INTEGER NOT NULL,
    "prevalence" DOUBLE PRECISION NOT NULL,
    "trueConfidenceAverage" DOUBLE PRECISION,
    "falseConfidenceAverage" DOUBLE PRECISION,
    "confidenceBuckets" JSONB NOT NULL DEFAULT '{}',
    "reasonDistribution" JSONB NOT NULL DEFAULT '{}',
    "ruleVersionDistribution" JSONB NOT NULL DEFAULT '{}',
    "completeness" TEXT NOT NULL,
    "policyHash" TEXT NOT NULL,
    "analyzerVersion" TEXT NOT NULL,
    "analysisRunId" TEXT,

    CONSTRAINT "LabelMetricSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelMetricDaily" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "labelDefinitionId" TEXT NOT NULL,
    "evaluatedCount" INTEGER NOT NULL,
    "trueCount" INTEGER NOT NULL,
    "prevalence" DOUBLE PRECISION NOT NULL,
    "confidenceBuckets" JSONB NOT NULL DEFAULT '{}',
    "reasonDistribution" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "LabelMetricDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountSummaryCurrent" (
    "generationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "normalizedScreenName" TEXT NOT NULL,
    "normalizedDisplayName" TEXT NOT NULL,
    "searchDocument" TEXT NOT NULL,
    "activeLabelKeys" TEXT[],
    "activeLabelCount" INTEGER NOT NULL,
    "lastClassificationChangedAt" TIMESTAMP(3),
    "lastRuleVersionChangedAt" TIMESTAMP(3),
    "activeFindingCount" INTEGER NOT NULL DEFAULT 0,
    "highestFindingSeverity" TEXT,
    "sourceWatermarkAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSummaryCurrent_pkey" PRIMARY KEY ("generationId","accountId")
);

-- CreateTable
CREATE TABLE "AccountClassificationCurrent" (
    "generationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "labelDefinitionId" TEXT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "lastChangedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountClassificationCurrent_pkey" PRIMARY KEY ("generationId","accountId","labelDefinitionId")
);

-- CreateTable
CREATE TABLE "AccountLabelChange" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "labelDefinitionId" TEXT NOT NULL,
    "changeType" TEXT NOT NULL,
    "previousValue" BOOLEAN,
    "newValue" BOOLEAN,
    "previousConfidence" DOUBLE PRECISION,
    "newConfidence" DOUBLE PRECISION,
    "previousReason" TEXT,
    "newReason" TEXT,
    "sourceId" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountLabelChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelSummaryCurrent" (
    "generationId" TEXT NOT NULL,
    "labelDefinitionId" TEXT NOT NULL,
    "latestSnapshotId" TEXT,
    "evaluatedCount" INTEGER NOT NULL,
    "trueCount" INTEGER NOT NULL,
    "prevalence" DOUBLE PRECISION NOT NULL,
    "previousRunDelta" DOUBLE PRECISION,
    "dayDelta" DOUBLE PRECISION,
    "weekDelta" DOUBLE PRECISION,
    "confidenceShift" JSONB NOT NULL DEFAULT '{}',
    "reasonShift" JSONB NOT NULL DEFAULT '{}',
    "activeFindingCount" INTEGER NOT NULL DEFAULT 0,
    "highestFindingSeverity" TEXT,
    "qualityStatus" TEXT NOT NULL,
    "sourceWatermarkAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabelSummaryCurrent_pkey" PRIMARY KEY ("generationId","labelDefinitionId")
);

-- CreateTable
CREATE TABLE "BlockRelationCurrent" (
    "generationId" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "normalizedBlockerScreenName" TEXT NOT NULL,
    "normalizedBlockedScreenName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "statusChangedAt" TIMESTAMP(3) NOT NULL,
    "activeFindingCount" INTEGER NOT NULL DEFAULT 0,
    "highestFindingSeverity" TEXT,
    "sourceWatermarkAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlockRelationCurrent_pkey" PRIMARY KEY ("generationId","blockId")
);

-- CreateTable
CREATE TABLE "BlockStateChange" (
    "id" TEXT NOT NULL,
    "blockId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceId" TEXT,

    CONSTRAINT "BlockStateChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttentionItemCurrent" (
    "generationId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "severity" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "impact" JSONB NOT NULL DEFAULT '{}',
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "freshness" TEXT NOT NULL,
    "detailHref" TEXT NOT NULL,

    CONSTRAINT "AttentionItemCurrent_pkey" PRIMARY KEY ("generationId","sourceType","sourceId")
);

-- CreateTable
CREATE TABLE "OverviewSnapshot" (
    "id" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceWatermarkAt" TIMESTAMP(3) NOT NULL,
    "operationalStatus" TEXT NOT NULL,
    "qualityStatus" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "analysisRunId" TEXT,

    CONSTRAINT "OverviewSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadModelGeneration" (
    "id" TEXT NOT NULL,
    "modelKey" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "sourceWatermarkAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "rowCount" INTEGER,
    "validationSummary" JSONB NOT NULL DEFAULT '{}',
    "analysisRunId" TEXT,

    CONSTRAINT "ReadModelGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReadModelPointer" (
    "modelKey" TEXT NOT NULL,
    "currentGenerationId" TEXT NOT NULL,
    "switchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReadModelPointer_pkey" PRIMARY KEY ("modelKey")
);

-- CreateTable
CREATE TABLE "ReadModelState" (
    "modelKey" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "currentGenerationId" TEXT,
    "sourceWatermarkAt" TIMESTAMP(3),
    "lastStartedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "expectedNextAt" TIMESTAMP(3),
    "delayedAt" TIMESTAMP(3),
    "staleAt" TIMESTAMP(3),
    "rowCount" INTEGER,
    "policyHash" TEXT,
    "analyzerVersion" TEXT,
    "errorCode" TEXT,
    "errorSummary" TEXT,

    CONSTRAINT "ReadModelState_pkey" PRIMARY KEY ("modelKey")
);

-- CreateIndex
CREATE INDEX "LabelMetricSnapshot_labelDefinitionId_observedAt_id_idx" ON "LabelMetricSnapshot"("labelDefinitionId", "observedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LabelMetricSnapshot_sourceCrawlRunId_labelDefinitionId_key" ON "LabelMetricSnapshot"("sourceCrawlRunId", "labelDefinitionId");

-- CreateIndex
CREATE INDEX "LabelMetricDaily_labelDefinitionId_date_idx" ON "LabelMetricDaily"("labelDefinitionId", "date" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "LabelMetricDaily_date_labelDefinitionId_key" ON "LabelMetricDaily"("date", "labelDefinitionId");

-- CreateIndex
CREATE INDEX "AccountSummaryCurrent_generationId_lastClassificationChange_idx" ON "AccountSummaryCurrent"("generationId", "lastClassificationChangedAt" DESC, "accountId");

-- CreateIndex
CREATE INDEX "AccountSummaryCurrent_generationId_highestFindingSeverity_a_idx" ON "AccountSummaryCurrent"("generationId", "highestFindingSeverity", "activeFindingCount", "accountId");

-- CreateIndex
CREATE INDEX "AccountSummaryCurrent_normalizedScreenName_idx" ON "AccountSummaryCurrent"("normalizedScreenName");

-- CreateIndex
CREATE INDEX "AccountClassificationCurrent_generationId_labelDefinitionId_idx" ON "AccountClassificationCurrent"("generationId", "labelDefinitionId", "value", "accountId");

-- CreateIndex
CREATE INDEX "AccountLabelChange_accountId_changedAt_idx" ON "AccountLabelChange"("accountId", "changedAt" DESC);

-- CreateIndex
CREATE INDEX "AccountLabelChange_labelDefinitionId_changedAt_id_idx" ON "AccountLabelChange"("labelDefinitionId", "changedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "LabelSummaryCurrent_generationId_qualityStatus_idx" ON "LabelSummaryCurrent"("generationId", "qualityStatus");

-- CreateIndex
CREATE INDEX "BlockRelationCurrent_generationId_status_statusChangedAt_bl_idx" ON "BlockRelationCurrent"("generationId", "status", "statusChangedAt" DESC, "blockId");

-- CreateIndex
CREATE INDEX "BlockStateChange_blockId_changedAt_id_idx" ON "BlockStateChange"("blockId", "changedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AttentionItemCurrent_generationId_priority_idx" ON "AttentionItemCurrent"("generationId", "priority");

-- CreateIndex
CREATE INDEX "OverviewSnapshot_generatedAt_idx" ON "OverviewSnapshot"("generatedAt" DESC);

-- CreateIndex
CREATE INDEX "ReadModelGeneration_modelKey_status_startedAt_idx" ON "ReadModelGeneration"("modelKey", "status", "startedAt" DESC);

-- pg_trgm による display name の部分一致検索用 GIN インデックス。
-- Prisma の schema DSL では trigram インデックスを表現できないため raw SQL で追加する。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "AccountSummaryCurrent_normalizedDisplayName_trgm_idx"
  ON "AccountSummaryCurrent" USING GIN ("normalizedDisplayName" gin_trgm_ops);
