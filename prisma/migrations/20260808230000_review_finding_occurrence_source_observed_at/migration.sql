-- AlterTable: AccountSummary が sourceWatermarkAt と比較する用の、
-- 元データ自体の観測時刻を observedAt (analyzer の処理時刻) と分離して持つ。
-- 既存行は両者を区別していなかったため observedAt の値で初期化する。
ALTER TABLE "ReviewFindingOccurrence" ADD COLUMN "sourceObservedAt" TIMESTAMP(3);
UPDATE "ReviewFindingOccurrence" SET "sourceObservedAt" = "observedAt";
ALTER TABLE "ReviewFindingOccurrence" ALTER COLUMN "sourceObservedAt" SET NOT NULL;

-- CreateIndex
CREATE INDEX "ReviewFindingOccurrence_findingId_sourceObservedAt_id_idx" ON "ReviewFindingOccurrence"("findingId", "sourceObservedAt" DESC, "id" DESC);
