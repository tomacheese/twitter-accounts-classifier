-- weekly review candidate は targetTo 時点の履歴を labeledAt DESC, id DESC で厳密に決める。
-- 期間を labelDefinitionId + labeledAt で先に絞り、dedupe/sample に必要な列だけを index-only scan する。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabel_weekly_review_candidate_time_cover_idx"
ON "AccountLabel" ("labelDefinitionId", "labeledAt" DESC, "id" DESC)
INCLUDE ("accountId", "value");
