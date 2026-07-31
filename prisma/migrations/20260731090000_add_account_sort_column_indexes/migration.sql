-- The Accounts page (viewer/lib/queries/accounts.ts's listAccounts) sorts by
-- whichever of "followersCount", "tweetCount", or "lastCrawledAt" the user
-- picked, with no other filter in the common case. Without an index on these
-- columns, Postgres has to sort the whole "Account" table on every page load
-- as it grows. Built CONCURRENTLY (and without a wrapping transaction, which
-- Postgres migrations from Prisma already run without) to avoid locking
-- writes against the live "Account" table while each index is built.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Account_followersCount_idx"
ON "Account" ("followersCount");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Account_tweetCount_idx"
ON "Account" ("tweetCount");

CREATE INDEX CONCURRENTLY IF NOT EXISTS "Account_lastCrawledAt_idx"
ON "Account" ("lastCrawledAt");
