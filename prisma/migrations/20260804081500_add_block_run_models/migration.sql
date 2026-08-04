-- CreateTable
CREATE TABLE "BlockRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,

    CONSTRAINT "BlockRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockAccountRun" (
    "id" TEXT NOT NULL,
    "blockRunId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "candidatesCount" INTEGER NOT NULL DEFAULT 0,
    "blockedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,

    CONSTRAINT "BlockAccountRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BlockAction" (
    "id" TEXT NOT NULL,
    "blockAccountRunId" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "labelDefinitionId" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "result" TEXT NOT NULL,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BlockRun_startedAt_idx" ON "BlockRun"("startedAt");

-- CreateIndex
CREATE INDEX "BlockRun_status_startedAt_id_idx" ON "BlockRun"("status", "startedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "BlockAccountRun_blockRunId_idx" ON "BlockAccountRun"("blockRunId");

-- CreateIndex
CREATE INDEX "BlockAccountRun_blockRunId_username_startedAt_id_idx" ON "BlockAccountRun"("blockRunId", "username", "startedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "BlockAction_blockerId_blockedId_result_idx" ON "BlockAction"("blockerId", "blockedId", "result");

-- CreateIndex
CREATE INDEX "BlockAction_blockAccountRunId_idx" ON "BlockAction"("blockAccountRunId");

-- AddForeignKey
ALTER TABLE "BlockAccountRun" ADD CONSTRAINT "BlockAccountRun_blockRunId_fkey" FOREIGN KEY ("blockRunId") REFERENCES "BlockRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockAction" ADD CONSTRAINT "BlockAction_blockAccountRunId_fkey" FOREIGN KEY ("blockAccountRunId") REFERENCES "BlockAccountRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockAction" ADD CONSTRAINT "BlockAction_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockAction" ADD CONSTRAINT "BlockAction_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BlockAction" ADD CONSTRAINT "BlockAction_labelDefinitionId_fkey" FOREIGN KEY ("labelDefinitionId") REFERENCES "LabelDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
