-- CreateIndex
CREATE INDEX "AccountLabel_labelDefinitionId_accountId_labeledAt_id_idx" ON "AccountLabel"("labelDefinitionId", "accountId", "labeledAt" DESC, "id" DESC);
