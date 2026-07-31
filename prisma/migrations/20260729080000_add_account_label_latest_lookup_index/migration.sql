-- The dashboard's "latest label value per account per label definition" queries
-- (getDashboardKpis/getLabelDistribution in viewer/lib/queries/dashboard.ts) use
-- `DISTINCT ON ("accountId", "labelDefinitionId") ... ORDER BY "accountId",
-- "labelDefinitionId", "labeledAt" DESC, "id" DESC`. The existing composite index
-- on (accountId, labelDefinitionId, labeledAt DESC) is missing the trailing `id`
-- column, so Postgres falls back to an index scan plus an extra sort/unique step
-- once "AccountLabel" grows large, instead of resolving the DISTINCT ON directly
-- from the index. Add the missing column so the index matches the query's ORDER
-- BY exactly. Built CONCURRENTLY (and without a wrapping transaction, which
-- Postgres migrations from Prisma already run without) to avoid locking writes
-- against the live "AccountLabel" table while the index is built.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "AccountLabel_accountId_labelDefinitionId_labeledAt_id_idx"
ON "AccountLabel" ("accountId", "labelDefinitionId", "labeledAt" DESC, "id" DESC);
