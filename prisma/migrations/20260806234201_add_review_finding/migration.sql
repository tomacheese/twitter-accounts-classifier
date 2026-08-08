-- 補足: 20260806233641_add_analysis_work_item と同じ理由により、
-- 自動生成された "AccountLabel_pre_compaction" (安全網テーブル) への DROP DDL を除去している。

-- CreateTable
CREATE TABLE "ReviewFinding" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "identityVersion" INTEGER NOT NULL,
    "episodeNumber" INTEGER NOT NULL DEFAULT 1,
    "type" TEXT NOT NULL,
    "primaryScopeType" TEXT NOT NULL,
    "primaryScopeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currentSeverity" TEXT NOT NULL,
    "maximumSeverity" TEXT NOT NULL,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "recurrenceCount" INTEGER NOT NULL DEFAULT 0,
    "previousFindingId" TEXT,
    "supersededByFindingId" TEXT,
    "currentOccurrenceId" TEXT,

    CONSTRAINT "ReviewFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewFindingOccurrence" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stateTransition" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "observedValue" DOUBLE PRECISION,
    "baselineValue" DOUBLE PRECISION,
    "absoluteDifference" DOUBLE PRECISION,
    "relativeDifference" DOUBLE PRECISION,
    "affectedCount" INTEGER,
    "totalCount" INTEGER,
    "affectedRatio" DOUBLE PRECISION,
    "consecutiveCount" INTEGER NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION,
    "thresholds" JSONB NOT NULL DEFAULT '{}',
    "measurements" JSONB NOT NULL DEFAULT '{}',
    "policyHash" TEXT NOT NULL,
    "detectorVersion" TEXT NOT NULL,
    "observationKey" TEXT NOT NULL,

    CONSTRAINT "ReviewFindingOccurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingEvidence" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "redactionVersion" INTEGER NOT NULL,
    "sampleStrategyVersion" TEXT,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingRawArtifact" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "isTruncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FindingRawArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FindingEntityLink" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,

    CONSTRAINT "FindingEntityLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectionPolicyVersion" (
    "id" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "loadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DetectionPolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DetectorEvaluation" (
    "id" TEXT NOT NULL,
    "detectorType" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "identityVersion" INTEGER NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isShadow" BOOLEAN NOT NULL DEFAULT false,
    "result" JSONB NOT NULL,
    "policyHash" TEXT NOT NULL,

    CONSTRAINT "DetectorEvaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyBacktestRun" (
    "id" TEXT NOT NULL,
    "candidatePolicyHash" TEXT NOT NULL,
    "baselinePolicyHash" TEXT NOT NULL,
    "targetFrom" TIMESTAMP(3) NOT NULL,
    "targetTo" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "summary" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "PolicyBacktestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyBacktestFinding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "diffKind" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "PolicyBacktestFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewFinding_status_currentSeverity_lastDetectedAt_id_idx" ON "ReviewFinding"("status", "currentSeverity", "lastDetectedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ReviewFinding_primaryScopeType_primaryScopeId_idx" ON "ReviewFinding"("primaryScopeType", "primaryScopeId");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewFinding_fingerprint_identityVersion_episodeNumber_key" ON "ReviewFinding"("fingerprint", "identityVersion", "episodeNumber");

-- CreateIndex
CREATE INDEX "ReviewFindingOccurrence_findingId_observedAt_id_idx" ON "ReviewFindingOccurrence"("findingId", "observedAt" DESC, "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ReviewFindingOccurrence_findingId_observationKey_key" ON "ReviewFindingOccurrence"("findingId", "observationKey");

-- CreateIndex
CREATE INDEX "FindingEvidence_findingId_kind_createdAt_idx" ON "FindingEvidence"("findingId", "kind", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "FindingRawArtifact_findingId_kind_idx" ON "FindingRawArtifact"("findingId", "kind");

-- CreateIndex
CREATE INDEX "FindingEntityLink_entityType_entityId_idx" ON "FindingEntityLink"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "FindingEntityLink_findingId_entityType_entityId_key" ON "FindingEntityLink"("findingId", "entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "DetectionPolicyVersion_policyVersion_key" ON "DetectionPolicyVersion"("policyVersion");

-- CreateIndex
CREATE INDEX "DetectorEvaluation_detectorType_fingerprint_evaluatedAt_idx" ON "DetectorEvaluation"("detectorType", "fingerprint", "evaluatedAt" DESC);

-- CreateIndex
CREATE INDEX "DetectorEvaluation_isShadow_evaluatedAt_idx" ON "DetectorEvaluation"("isShadow", "evaluatedAt" DESC);

-- CreateIndex
CREATE INDEX "PolicyBacktestFinding_runId_diffKind_idx" ON "PolicyBacktestFinding"("runId", "diffKind");

-- AddForeignKey
ALTER TABLE "ReviewFindingOccurrence" ADD CONSTRAINT "ReviewFindingOccurrence_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "ReviewFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEvidence" ADD CONSTRAINT "FindingEvidence_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "ReviewFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FindingEntityLink" ADD CONSTRAINT "FindingEntityLink_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "ReviewFinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyBacktestFinding" ADD CONSTRAINT "PolicyBacktestFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PolicyBacktestRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
