-- CreateIndex
CREATE INDEX "AccountSummaryCurrent_generationId_normalizedScreenName_acc_idx" ON "AccountSummaryCurrent"("generationId", "normalizedScreenName", "accountId");

-- CreateIndex
CREATE INDEX "DetectorEvaluation_fingerprint_identityVersion_evaluatedAt_idx" ON "DetectorEvaluation"("fingerprint", "identityVersion", "evaluatedAt" DESC);

-- CreateIndex
CREATE INDEX "OperationCycle_kind_triggeredAt_id_idx" ON "OperationCycle"("kind", "triggeredAt" DESC, "id" DESC);
