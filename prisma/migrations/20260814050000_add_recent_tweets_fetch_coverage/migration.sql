ALTER TABLE "Account"
ADD COLUMN "lastRecentTweetsAttemptedAt" TIMESTAMP(3),
ADD COLUMN "lastRecentTweetsFetchedAt" TIMESTAMP(3),
ADD COLUMN "recentTweetsFetchStatus" TEXT;
