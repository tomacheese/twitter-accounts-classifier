-- CreateIndex
CREATE INDEX "BlockAccountRun_errorMessage_startedAt_id_idx" ON "BlockAccountRun"("errorMessage", "startedAt" DESC, "id" DESC);
