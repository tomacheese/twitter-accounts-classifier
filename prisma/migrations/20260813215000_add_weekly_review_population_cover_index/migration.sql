-- weekly review の population count は、期間内の各 (labelDefinitionId, accountId) の最新 evaluable 行を読む。
-- 既存 index は DISTINCT ON の順序を満たすが value/evaluable のために heap fetch が必要で、
-- 1億行超の AccountLabel では label 単位に分割しても statement_timeout=120s を超える。
-- evaluable 行だけに絞り value を INCLUDE して index-only scan を可能にする。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabel_weekly_review_population_cover_idx"
ON "AccountLabel" ("labelDefinitionId", "accountId", "labeledAt" DESC, "id" DESC)
INCLUDE ("value")
WHERE "evaluable";
