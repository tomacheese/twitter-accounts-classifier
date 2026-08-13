-- reasonDistribution を value = true に絞った index-only scan にするため、
-- 既存の (labelDefinitionId, value, accountId) index とは別に reason を含む
-- covering index を追加する。Prisma schema には表現しない raw SQL 側だけの
-- 変更とし、CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう
-- 1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountClassificationLatest_label_value_reason_cover_idx"
ON "AccountClassificationLatest" ("labelDefinitionId", "value") INCLUDE ("accountId", "reason");
