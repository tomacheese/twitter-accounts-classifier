-- reply corpus は isReply = true の行のみを読むため部分索引にする。
-- CREATE INDEX CONCURRENTLY を transaction 外で実行できるよう、1 文だけに保つ。
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Tweet_reply_corpus_idx"
  ON "Tweet" ("collectedAt" DESC, "id" DESC) WHERE "isReply" = true;
