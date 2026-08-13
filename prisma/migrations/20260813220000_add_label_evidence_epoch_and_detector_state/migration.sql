CREATE TABLE "LabelEvidenceEpoch" (
    "id" TEXT NOT NULL,
    "crawlRunId" TEXT NOT NULL,
    "sourceWatermarkAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabelEvidenceEpoch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DetectorState" (
    "detectorKey" TEXT NOT NULL,
    "lastEvidenceEpochId" TEXT,
    "sourceWatermarkAt" TIMESTAMP(3),
    "lastStartedAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastFailureAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorSummary" TEXT,
    "policyHash" TEXT,
    "analyzerVersion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DetectorState_pkey" PRIMARY KEY ("detectorKey")
);

CREATE UNIQUE INDEX "LabelEvidenceEpoch_crawlRunId_key" ON "LabelEvidenceEpoch"("crawlRunId");
CREATE INDEX "LabelEvidenceEpoch_sourceWatermarkAt_idx" ON "LabelEvidenceEpoch"("sourceWatermarkAt" DESC);

ALTER TABLE "LabelEvidenceEpoch" ADD CONSTRAINT "LabelEvidenceEpoch_crawlRunId_fkey"
FOREIGN KEY ("crawlRunId") REFERENCES "CrawlRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "DetectorState" (
    "detectorKey",
    "sourceWatermarkAt",
    "lastSuccessAt",
    "lastFailureAt",
    "errorCode",
    "errorSummary",
    "policyHash",
    "analyzerVersion",
    "updatedAt"
)
SELECT
    'label_findings',
    "sourceWatermarkAt",
    "lastSuccessAt",
    "lastFailureAt",
    "errorCode",
    "errorSummary",
    "policyHash",
    "analyzerVersion",
    now()
FROM "ReadModelState"
WHERE "modelKey" = 'label_findings'
ON CONFLICT ("detectorKey") DO NOTHING;

ALTER TABLE "AccountLabelLatest" ALTER COLUMN "accountId" SET STATISTICS 1000;
