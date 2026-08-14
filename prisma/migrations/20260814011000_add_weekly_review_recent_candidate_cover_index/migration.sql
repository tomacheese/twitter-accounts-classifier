-- weekly-review の candidate sampling は label ごとに AccountLabelLatest の期間 window を読む。
-- heap fetch を避けて index-only scan できるよう、sampling frame に必要な列だけを INCLUDE する。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabelLatest_weekly_review_candidate_time_cover_idx"
ON "AccountLabelLatest" ("labelDefinitionId", "labeledAt" DESC)
INCLUDE ("accountId", "value");
