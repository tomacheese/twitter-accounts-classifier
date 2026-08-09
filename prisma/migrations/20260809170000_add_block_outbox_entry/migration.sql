-- CreateTable
CREATE TABLE "BlockOutboxEntry" (
    "id" TEXT NOT NULL,
    "blockAccountRunId" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "labelDefinitionId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remoteSucceededAt" TIMESTAMP(3),
    "localPersistedAt" TIMESTAMP(3),
    "reconciledAt" TIMESTAMP(3),

    CONSTRAINT "BlockOutboxEntry_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "BlockAction" ADD COLUMN     "outboxEntryId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BlockOutboxEntry_blockerId_blockedId_key" ON "BlockOutboxEntry"("blockerId", "blockedId");

-- CreateIndex
CREATE INDEX "BlockOutboxEntry_status_createdAt_idx" ON "BlockOutboxEntry"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BlockAction_outboxEntryId_key" ON "BlockAction"("outboxEntryId");

-- AddForeignKey
ALTER TABLE "BlockAction" ADD CONSTRAINT "BlockAction_outboxEntryId_fkey" FOREIGN KEY ("outboxEntryId") REFERENCES "BlockOutboxEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockOutboxEntry" ADD CONSTRAINT "BlockOutboxEntry_blockAccountRunId_fkey" FOREIGN KEY ("blockAccountRunId") REFERENCES "BlockAccountRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockOutboxEntry" ADD CONSTRAINT "BlockOutboxEntry_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockOutboxEntry" ADD CONSTRAINT "BlockOutboxEntry_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockOutboxEntry" ADD CONSTRAINT "BlockOutboxEntry_labelDefinitionId_fkey" FOREIGN KEY ("labelDefinitionId") REFERENCES "LabelDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
