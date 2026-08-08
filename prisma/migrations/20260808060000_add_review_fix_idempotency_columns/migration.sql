-- AlterTable: DetectorEvaluation の at-least-once retry を冪等にするための sourceId
ALTER TABLE "DetectorEvaluation" ADD COLUMN "sourceId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "DetectorEvaluation" ALTER COLUMN "sourceId" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "DetectorEvaluation_fingerprint_identityVersion_sourceId_isSh_key" ON "DetectorEvaluation"("fingerprint", "identityVersion", "sourceId", "isShadow");

-- AlterTable: OverviewSnapshot を ReadModelGeneration/Pointer 経由の原子的公開に乗せるための generationId
ALTER TABLE "OverviewSnapshot" ADD COLUMN "generationId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "OverviewSnapshot" ALTER COLUMN "generationId" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "OverviewSnapshot_generationId_key" ON "OverviewSnapshot"("generationId");
