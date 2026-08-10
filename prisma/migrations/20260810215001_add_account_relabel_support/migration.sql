-- AlterTable
ALTER TABLE "AnalysisWorkItem" ADD COLUMN     "staleRequestedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "RelabelScanCursor" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "lastScannedAccountId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RelabelScanCursor_pkey" PRIMARY KEY ("id")
);
