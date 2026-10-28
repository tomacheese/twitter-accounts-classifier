-- AlterTable
ALTER TABLE "BioDuplicateClusterSize" ADD COLUMN "memberIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
