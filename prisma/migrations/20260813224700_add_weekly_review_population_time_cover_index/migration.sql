-- weekly review は label ごとの7日 window を先に切り出してから account 単位に重複排除する。
-- labelDefinitionId の等価条件と labeledAt の range 条件を index scan の先頭キーに置き、
-- accountId/value を INCLUDE して window 抽出を index-only scan にする。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabel_weekly_review_population_time_cover_idx"
ON "AccountLabel" ("labelDefinitionId", "labeledAt" DESC, "id" DESC)
INCLUDE ("accountId", "value")
WHERE "evaluable";
