-- AlterTable
ALTER TABLE "BlockOutboxEntry"
  ADD COLUMN     "remoteSkipCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN     "lastRemoteSkippedAt" TIMESTAMP(3);

-- 既存の remote_skipped 行は少なくとも1回 code 50 を経験しているが、
-- BlockAction は outboxEntryId 単位の upsert で試行履歴を保持していないため、
-- 正確な過去回数は復元できない。再試行の機会を奪わない安全側として 1 回目として扱う。
UPDATE "BlockOutboxEntry"
SET "remoteSkipCount" = 1, "lastRemoteSkippedAt" = now()
WHERE "status" = 'remote_skipped';
