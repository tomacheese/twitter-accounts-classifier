-- AlterTable
ALTER TABLE "LabelDefinition" ADD COLUMN     "currentRuleVersion" TEXT;

-- CreateIndex
CREATE INDEX "AccountLabelLatest_labelDefinitionId_ruleVersion_idx" ON "AccountLabelLatest"("labelDefinitionId", "ruleVersion");
