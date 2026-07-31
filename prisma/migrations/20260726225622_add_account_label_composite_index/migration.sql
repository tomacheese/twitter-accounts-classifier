-- CreateIndex
-- CONCURRENTLY avoids locking AccountLabel against the crawler's writes while
-- the index builds. Prisma Migrate only skips wrapping a migration in a
-- transaction when the file contains a single statement (CONCURRENTLY cannot
-- run inside one) — keep this migration as exactly one statement.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabel_accountId_labelDefinitionId_labeledAt_idx" ON "AccountLabel"("accountId", "labelDefinitionId", "labeledAt" DESC);
