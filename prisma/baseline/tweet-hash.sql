-- Tweet の HASH(accountId) x 32 版。baseline.sql の後に適用する (tweet-range.sql とはどちらか一方だけを使う)。
--
-- 一意制約はパーティションキーを含む必要があるため、PK は (accountId, id) になる。
-- Tweet ID だけでの検索は、各パーティションの (id) インデックスを 32 本引く (全件走査にはならない)。
-- アカウント指定の取得 (直近 20 件など) は、accountId でパーティションが 1 つに絞られる。
-- Account への FK は張らない。INSERT ごとの親行ロックと検証コストを避けるため。
--
-- quoteCount、retweetedTweetId、quotedTweetId、source は参照がないため持たない。
-- expandedUrls と cardDestinationUrls は、空配列を NULL で保存する。列は NULL 可で既定値は付けない。
-- 列は 8B 境界、4B、1B、可変長の順に並べる。

CREATE TABLE "Tweet" (
    "id" BIGINT NOT NULL,
    "accountId" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "collectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inReplyToTweetId" BIGINT,
    "conversationId" BIGINT,
    "quotedTweetAuthorId" BIGINT,
    "retweetCount" INTEGER NOT NULL,
    "likeCount" INTEGER NOT NULL,
    "replyCount" INTEGER NOT NULL,
    "foreignVideoSourceCount" INTEGER,
    "isReply" BOOLEAN NOT NULL DEFAULT false,
    "isAuthorReply" BOOLEAN NOT NULL DEFAULT false,
    "isRetweet" BOOLEAN NOT NULL DEFAULT false,
    "isPromoted" BOOLEAN NOT NULL DEFAULT false,
    "isPaidPromotion" BOOLEAN NOT NULL DEFAULT false,
    "cardDestinationUrlsEvaluated" BOOLEAN NOT NULL DEFAULT false,
    "hasMedia" BOOLEAN,
    "hasAiGeneratedMedia" BOOLEAN,
    "quotedTweetHasVideo" BOOLEAN,
    "aiGeneratedDetectionSource" TEXT,
    "expandedUrls" TEXT[],
    "cardDestinationUrls" TEXT[],
    "fullText" TEXT NOT NULL,

    CONSTRAINT "Tweet_pkey" PRIMARY KEY ("accountId", "id")
) PARTITION BY HASH ("accountId");

-- アカウント指定で新しい順に引く。
CREATE INDEX "Tweet_accountId_createdAt_idx" ON "Tweet" ("accountId", "createdAt");

-- Tweet ID だけで引く経路 (findMissingTweetIds、findTweetContextsByIds) 用。
-- PK が (accountId, id) のため、id 単独の条件ではこの索引がなければ全パーティションを走査する。
CREATE INDEX "Tweet_id_idx" ON "Tweet" ("id");

-- reply corpus 用。isReply = true の行だけを、新しい順に引く。
CREATE INDEX "Tweet_reply_corpus_idx" ON "Tweet" ("collectedAt" DESC, "id" DESC) WHERE "isReply" = true;

-- パーティションの storage parameter は、親表では指定できないため子ごとに指定する。
-- insert 主体の表なので、insert 起点の autovacuum を早める。
DO $$
BEGIN
  FOR i IN 0..31 LOOP
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "Tweet" FOR VALUES WITH (MODULUS 32, REMAINDER %s) '
      'WITH (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_insert_scale_factor = 0.01)',
      'Tweet_h' || lpad(i::text, 2, '0'), i
    );
  END LOOP;
END
$$;
