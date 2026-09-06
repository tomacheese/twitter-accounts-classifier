-- 20260906010000 で旧 unique index (accountId, labelDefinitionId, changedAt) を
-- 削除した代わりの通常 index。CREATE INDEX CONCURRENTLY を transaction 外で
-- 実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabelChange_accountId_labelDefinitionId_changedAt_idx"
  ON "AccountLabelChange"("accountId", "labelDefinitionId", "changedAt");
