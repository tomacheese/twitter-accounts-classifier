-- CreateTable
CREATE TABLE "LabelingFollowSample" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "followeeId" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabelingFollowSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabelingFollowSample_accountId_idx" ON "LabelingFollowSample"("accountId");

-- CreateIndex
CREATE INDEX "LabelingFollowSample_followeeId_idx" ON "LabelingFollowSample"("followeeId");

-- CreateIndex
CREATE UNIQUE INDEX "LabelingFollowSample_accountId_followeeId_key" ON "LabelingFollowSample"("accountId", "followeeId");

-- AddForeignKey
ALTER TABLE "LabelingFollowSample" ADD CONSTRAINT "LabelingFollowSample_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LabelingFollowSample" ADD CONSTRAINT "LabelingFollowSample_followeeId_fkey" FOREIGN KEY ("followeeId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
