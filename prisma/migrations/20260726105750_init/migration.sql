-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "screenName" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "bio" TEXT,
    "profileImageUrl" TEXT,
    "followersCount" INTEGER NOT NULL,
    "followingCount" INTEGER NOT NULL,
    "tweetCount" INTEGER NOT NULL,
    "accountCreatedAt" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "url" TEXT,
    "isBlueVerified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedType" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCrawledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tweet" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fullText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "retweetCount" INTEGER NOT NULL,
    "likeCount" INTEGER NOT NULL,
    "replyCount" INTEGER NOT NULL,
    "quoteCount" INTEGER NOT NULL,
    "isReply" BOOLEAN NOT NULL DEFAULT false,
    "inReplyToTweetId" TEXT,
    "isAuthorReply" BOOLEAN NOT NULL DEFAULT false,
    "isRetweet" BOOLEAN NOT NULL DEFAULT false,
    "retweetedTweetId" TEXT,
    "source" TEXT NOT NULL,
    "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Tweet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LabelDefinition" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabelDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountLabel" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "labelDefinitionId" TEXT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reason" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "labeledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountLabel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WeeklyAnalysisRun" (
    "id" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "sampledAccountIds" JSONB NOT NULL,
    "findings" TEXT,
    "commitSha" TEXT,

    CONSTRAINT "WeeklyAnalysisRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Tweet_accountId_idx" ON "Tweet"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "LabelDefinition_key_key" ON "LabelDefinition"("key");

-- CreateIndex
CREATE INDEX "AccountLabel_accountId_idx" ON "AccountLabel"("accountId");

-- CreateIndex
CREATE INDEX "AccountLabel_labelDefinitionId_idx" ON "AccountLabel"("labelDefinitionId");

-- AddForeignKey
ALTER TABLE "Tweet" ADD CONSTRAINT "Tweet_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLabel" ADD CONSTRAINT "AccountLabel_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLabel" ADD CONSTRAINT "AccountLabel_labelDefinitionId_fkey" FOREIGN KEY ("labelDefinitionId") REFERENCES "LabelDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
