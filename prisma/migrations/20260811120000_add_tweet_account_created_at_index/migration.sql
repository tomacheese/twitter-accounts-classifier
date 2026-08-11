-- DropIndex
DROP INDEX "Tweet_accountId_idx";

-- CreateIndex
CREATE INDEX "Tweet_accountId_createdAt_idx" ON "Tweet"("accountId", "createdAt");
