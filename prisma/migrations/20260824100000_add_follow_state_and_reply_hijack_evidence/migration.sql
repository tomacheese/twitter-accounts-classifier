CREATE TABLE "FollowStateChange" (
  "id" TEXT NOT NULL,
  "followerId" TEXT NOT NULL,
  "followeeId" TEXT NOT NULL,
  "changeType" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FollowStateChange_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "FollowStateChange_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FollowStateChange_followeeId_fkey" FOREIGN KEY ("followeeId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "FollowStateChange_changeType_check" CHECK ("changeType" IN ('followed', 'unfollowed'))
);

CREATE INDEX "FollowStateChange_followerId_observedAt_idx" ON "FollowStateChange" ("followerId", "observedAt" DESC);
CREATE INDEX "FollowStateChange_followeeId_observedAt_idx" ON "FollowStateChange" ("followeeId", "observedAt" DESC);

CREATE TABLE "ReplyHijackEvidence" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "targetTweetId" TEXT NOT NULL,
  "ruleVersion" TEXT NOT NULL,
  "observedAt" TIMESTAMP(3) NOT NULL,
  "swarmSize" INTEGER NOT NULL,
  "averageSimilarity" DOUBLE PRECISION NOT NULL,
  "spanHours" DOUBLE PRECISION NOT NULL,
  "replyTweetIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  CONSTRAINT "ReplyHijackEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReplyHijackEvidence_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReplyHijackEvidence_accountId_targetTweetId_ruleVersion_key"
  ON "ReplyHijackEvidence" ("accountId", "targetTweetId", "ruleVersion");
CREATE INDEX "ReplyHijackEvidence_targetTweetId_idx" ON "ReplyHijackEvidence" ("targetTweetId");
