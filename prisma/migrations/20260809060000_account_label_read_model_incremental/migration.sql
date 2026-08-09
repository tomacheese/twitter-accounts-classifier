-- CreateTable: 新規モデルは追加のみのため、生成されたそのままの CreateTable 文を使う。
CREATE TABLE "AccountSummaryLatest" (
    "accountId" TEXT NOT NULL,
    "normalizedScreenName" TEXT NOT NULL,
    "normalizedDisplayName" TEXT NOT NULL,
    "searchDocument" TEXT NOT NULL,
    "profileObservedAt" TIMESTAMP(3) NOT NULL,
    "activeLabelKeys" TEXT[],
    "activeLabelCount" INTEGER NOT NULL,
    "lastClassificationChangedAt" TIMESTAMP(3),
    "classificationObservedAt" TIMESTAMP(3),
    "activeFindingCount" INTEGER NOT NULL DEFAULT 0,
    "highestFindingSeverity" TEXT,
    "findingObservedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSummaryLatest_pkey" PRIMARY KEY ("accountId")
);

CREATE TABLE "AccountClassificationLatest" (
    "accountId" TEXT NOT NULL,
    "labelDefinitionId" TEXT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "sourceObservationId" TEXT,

    CONSTRAINT "AccountClassificationLatest_pkey" PRIMARY KEY ("accountId","labelDefinitionId")
);

CREATE TABLE "AccountClassificationObservation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "crawlRunId" TEXT,
    "username" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "labelCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountClassificationObservation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReadModelBootstrap" (
    "modelKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "cursor" TEXT,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "errorSummary" TEXT,

    CONSTRAINT "ReadModelBootstrap_pkey" PRIMARY KEY ("modelKey")
);

CREATE INDEX "AccountSummaryLatest_lastClassificationChangedAt_accountId_idx" ON "AccountSummaryLatest"("lastClassificationChangedAt" DESC, "accountId");
CREATE INDEX "AccountSummaryLatest_highestFindingSeverity_activeFindingCo_idx" ON "AccountSummaryLatest"("highestFindingSeverity", "activeFindingCount", "accountId");
CREATE INDEX "AccountSummaryLatest_normalizedScreenName_idx" ON "AccountSummaryLatest"("normalizedScreenName");
CREATE INDEX "AccountClassificationLatest_labelDefinitionId_value_account_idx" ON "AccountClassificationLatest"("labelDefinitionId", "value", "accountId");
CREATE INDEX "AccountClassificationObservation_accountId_observedAt_idx" ON "AccountClassificationObservation"("accountId", "observedAt" DESC);

-- AlterTable: 追加のみのため既定値付きで追加する。
ALTER TABLE "CrawlAccountRun" ADD COLUMN "classificationStatus" TEXT NOT NULL DEFAULT 'unknown';

-- LabelMetricSnapshot: 既存行を壊さない安全な列・制約変更手順。
-- 1. 列は NOT NULL 制約なしで追加する (既存行に値が無いため)。
ALTER TABLE "LabelMetricSnapshot" ADD COLUMN "triggerWorkItemId" TEXT;
ALTER TABLE "LabelMetricSnapshot" ADD COLUMN "populationCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LabelMetricSnapshot" ADD COLUMN "coverage" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "LabelMetricSnapshot" ADD COLUMN "currentCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LabelMetricSnapshot" ADD COLUMN "delayedCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LabelMetricSnapshot" ADD COLUMN "staleCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LabelMetricSnapshot" ADD COLUMN "unknownCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LabelMetricSnapshot" ADD COLUMN "staleRatio" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- 2. 既存行は行ごとに一意な 'legacy:' + id を snapshot set 識別子として backfill する。
--    複数行が同じ sourceCrawlRunId を共有し得るため、それをそのまま識別子にすると
--    後段の一意制約 (triggerWorkItemId, labelDefinitionId) に違反する。
UPDATE "LabelMetricSnapshot" SET "triggerWorkItemId" = 'legacy:' || "id" WHERE "triggerWorkItemId" IS NULL;

-- 3. backfill 後に NOT NULL を課す。
ALTER TABLE "LabelMetricSnapshot" ALTER COLUMN "triggerWorkItemId" SET NOT NULL;

-- 4. 新しい一意制約を先に作ってから、旧一意制約を落とす。
CREATE UNIQUE INDEX "LabelMetricSnapshot_triggerWorkItemId_labelDefinitionId_key"
  ON "LabelMetricSnapshot" ("triggerWorkItemId", "labelDefinitionId");

DROP INDEX IF EXISTS "LabelMetricSnapshot_sourceCrawlRunId_labelDefinitionId_key";

-- 5. sourceCrawlRunId は今後 crawl_run 起因以外の snapshot set でも null になり得るため nullable 化する。
ALTER TABLE "LabelMetricSnapshot" ALTER COLUMN "sourceCrawlRunId" DROP NOT NULL;

-- AccountSummaryLatest/AccountClassificationLatest の部分一致検索用 GIN インデックス
-- (既存 AccountSummaryCurrent の GIN インデックスと同じ構成)。
CREATE INDEX "AccountSummaryLatest_normalizedDisplayName_gin_idx"
  ON "AccountSummaryLatest" USING GIN ("normalizedDisplayName" gin_trgm_ops);
CREATE INDEX "AccountSummaryLatest_searchDocument_gin_idx"
  ON "AccountSummaryLatest" USING GIN ("searchDocument" gin_trgm_ops);

-- 旧 kind ('label_metrics'/'finding_generation') の未処理 AnalysisWorkItem は、
-- この migration 以降どの worker も処理関数を持たないため retry のたびに
-- Unknown work item kind で失敗し続ける。dead として確定させ、無駄な retry を止める。
UPDATE "AnalysisWorkItem"
  SET "status" = 'dead', "lastErrorSummary" = 'kind superseded by label_aggregate_refresh'
  WHERE "kind" IN ('label_metrics', 'finding_generation')
    AND "status" IN ('queued', 'leased', 'failed');
