-- 未採用。本番は tweet-hash.sql を使う。比較と検証のために残している。
-- Tweet の RANGE(id) 版。baseline.sql の後に適用する (tweet-hash.sql とはどちらか一方だけを使う)。
--
-- Tweet ID は snowflake で時間順になるため、ID の範囲が作成時刻の範囲に対応する。
-- PK は (id) のままでよい。古いパーティションを凍結でき、id 降順の LIMIT では新しいパーティションだけを読める。
-- アカウント指定の取得のため、各パーティションに (accountId, id DESC) のインデックスを持つ。
-- パーティションの作成は運用で継続する。範囲外の ID の INSERT は失敗するため、
-- 先の月まで create_tweet_month_partitions で作っておく (この baseline は 2027-12 まで作る)。
-- Account への FK は張らない。
--
-- quoteCount、retweetedTweetId、quotedTweetId、source は参照がないため持たない。
-- expandedUrls と cardDestinationUrls は、空配列を NULL で保存する。

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

    CONSTRAINT "Tweet_pkey" PRIMARY KEY ("id")
) PARTITION BY RANGE ("id");

CREATE INDEX "Tweet_accountId_createdAt_idx" ON "Tweet" ("accountId", "createdAt");

-- アカウント指定で、id 降順に新しいパーティションから読む。
CREATE INDEX "Tweet_accountId_id_idx" ON "Tweet" ("accountId", "id" DESC);

CREATE INDEX "Tweet_reply_corpus_idx" ON "Tweet" ("collectedAt" DESC, "id" DESC) WHERE "isReply" = true;

-- 時刻から、その時刻以降の最小の snowflake ID を返す。Twitter のエポックより前は 0 に丸める。
CREATE FUNCTION tweet_id_floor(p_ts timestamptz) RETURNS bigint
  LANGUAGE sql IMMUTABLE
  AS $$
  SELECT GREATEST(
    (floor(extract(epoch FROM p_ts) * 1000)::bigint - 1288834974657) << 22,
    0
  )
$$;

CREATE FUNCTION create_tweet_range_partition(p_name text, p_from timestamptz, p_to timestamptz)
  RETURNS void
  LANGUAGE plpgsql
  AS $$
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF "Tweet" FOR VALUES FROM (%s) TO (%s) '
    'WITH (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_insert_scale_factor = 0.01)',
    p_name,
    CASE WHEN p_from IS NULL THEN 'MINVALUE' ELSE tweet_id_floor(p_from)::text END,
    tweet_id_floor(p_to)
  );
END
$$;

-- p_start の月 (UTC) から p_months か月分の月次パーティションを作る。既にあるものは作らない。
CREATE FUNCTION create_tweet_month_partitions(p_start date, p_months int) RETURNS void
  LANGUAGE plpgsql
  AS $$
DECLARE
  v_from timestamptz;
  v_to timestamptz;
BEGIN
  FOR i IN 0..p_months - 1 LOOP
    v_from := (date_trunc('month', p_start::timestamp) + make_interval(months => i)) AT TIME ZONE 'UTC';
    v_to := (date_trunc('month', p_start::timestamp) + make_interval(months => i + 1)) AT TIME ZONE 'UTC';
    PERFORM create_tweet_range_partition('Tweet_p' || to_char(v_from AT TIME ZONE 'UTC', 'YYYYMM'), v_from, v_to);
  END LOOP;
END
$$;

-- snowflake 以前 (2011 年より前) の ID と、2011 年から 2024 年までの年次パーティション、2025 年以降の月次パーティション。
SELECT create_tweet_range_partition('Tweet_pre2011', NULL, timestamptz '2011-01-01 00:00:00+00');
SELECT create_tweet_range_partition(
  'Tweet_p' || y,
  make_timestamptz(y, 1, 1, 0, 0, 0, 'UTC'),
  make_timestamptz(y + 1, 1, 1, 0, 0, 0, 'UTC')
) FROM generate_series(2011, 2024) AS y;
SELECT create_tweet_month_partitions(date '2025-01-01', 36);
