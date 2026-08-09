-- AlterTable: 既存行を壊さない安全な列追加。
ALTER TABLE "LabelSummaryCurrent" ADD COLUMN "populationCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LabelSummaryCurrent" ADD COLUMN "coverage" DOUBLE PRECISION NOT NULL DEFAULT 0;
