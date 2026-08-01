-- AlterTable
-- quotedTweetId/quotedTweetAuthorId/quotedTweetHasVideo have no default (NULL) rather than
-- defaulting to false: existing rows collected before these columns existed never had their
-- quoted tweet evaluated for video content at all, and defaulting them would misrepresent
-- that gap as "checked and confirmed no quoted video" instead of "unknown".
ALTER TABLE "Tweet" ADD COLUMN     "quotedTweetId" TEXT,
ADD COLUMN     "quotedTweetAuthorId" TEXT,
ADD COLUMN     "quotedTweetHasVideo" BOOLEAN;
