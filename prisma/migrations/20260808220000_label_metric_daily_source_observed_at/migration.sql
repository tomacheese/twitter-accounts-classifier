-- AlterTable: backlog build による巻き戻り防止用に、行の値が採用された元
-- LabelMetricSnapshot.observedAt を記録する。既存行は判定基準を持たなかった
-- ため、CURRENT_TIMESTAMP で初期化し以降の build からの上書き対象として扱う。
ALTER TABLE "LabelMetricDaily" ADD COLUMN "sourceObservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "LabelMetricDaily" ALTER COLUMN "sourceObservedAt" DROP DEFAULT;
