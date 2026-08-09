-- AccountSummary の keyset scan は id 順に Account 本体の heap を辿ると HDD 上でランダム I/O になる。
-- 必要列を INCLUDE して index-only scan にし、初回 read model build を実用時間内に収める。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Account_account_summary_cover_idx"
ON "Account" ("id") INCLUDE ("screenName", "displayName", "updatedAt");
