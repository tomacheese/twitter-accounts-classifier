-- CreateIndex
CREATE INDEX "Tweet_reply_corpus_idx" ON "Tweet" ("collectedAt" DESC, "id" DESC) WHERE "isReply" = true;
