-- AlterTable
ALTER TABLE "AccountLabel" ADD COLUMN "evaluable" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "AccountLabelLatest" ADD COLUMN "evaluable" BOOLEAN NOT NULL DEFAULT true;
