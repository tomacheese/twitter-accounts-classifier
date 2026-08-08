-- 変化イベント自体の同一性 (accountId + labelDefinitionId + changedAt) で重複排除するよう、
-- 一意制約を sourceId ベースから差し替える。changedAt は変化の原因になった
-- AccountLabel.labeledAt を指すため、ANALYZER_WORKER_CONCURRENCY > 1 の並行 build 同士が
-- 同じ変化イベントを検出しても安全に重複挿入を防げる。
DROP INDEX "AccountLabelChange_sourceId_accountId_labelDefinitionId_key";

CREATE UNIQUE INDEX "AccountLabelChange_accountId_labelDefinitionId_changedAt_key" ON "AccountLabelChange"("accountId", "labelDefinitionId", "changedAt");
