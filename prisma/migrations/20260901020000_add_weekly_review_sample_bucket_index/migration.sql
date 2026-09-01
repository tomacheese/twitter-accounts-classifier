-- weekly review baseline sampling が bucket 集合を絞り込んで
-- AccountClassificationLatest を読むための partial functional index。
-- CREATE INDEX CONCURRENTLY をトランザクション外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountClassificationLatest_weekly_review_sample_idx"
ON "AccountClassificationLatest" ("labelDefinitionId", "value", weekly_review_sample_bucket("accountId"), "accountId")
WHERE "evaluable" = true AND "labeledAt" IS NOT NULL;
