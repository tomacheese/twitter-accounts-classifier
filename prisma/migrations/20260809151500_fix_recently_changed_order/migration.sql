-- recentlyChanged は変更日時の新しい行を先に返し、未変更 (NULL) は末尾へ送る。
-- Prisma schema DSL では PostgreSQL の NULLS LAST を索引上に表現できないため raw SQL で作る。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountSummaryCurrent_recentlyChanged_idx"
  ON "AccountSummaryCurrent" ("generationId", "lastClassificationChangedAt" DESC NULLS LAST, "accountId" DESC);
