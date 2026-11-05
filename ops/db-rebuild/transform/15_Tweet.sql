-- Tweet。text 形式で流し、tools/tweet-route.py が先頭列 (part_no) で子パーティションごとのストリームへ振り分ける。
-- 振り分け後の各ストリームは、子パーティションを作った同一トランザクションで COPY ... FREEZE する。
-- part_expr は load.sh が選択中のパーティション方式 (HASH か RANGE) から作る式で、行の所属先の番号を返す。
--
-- 旧 DB で処理中の backfill:text-only-media がまだ埋めていない行は、同じ判定で確定値にする。
--   - foreignVideoSourceCount IS NULL かつ collectedAt が fv_since 以降: 0
--   - hasMedia IS NULL かつ collectedAt が hm_since 以降: false
-- 各列の判定が収集に入る前の行は本当に未評価なので、NULL のまま残す。
-- 参照のない 4 列 (quoteCount、retweetedTweetId、quotedTweetId、source) は出力しない。
-- expandedUrls と cardDestinationUrls は、空配列を NULL にする (新 baseline の方針)。
-- id 系の列は数字だけの文字列を bigint に変換する。
-- target: "Tweet"
-- columns: "id", "accountId", "createdAt", "collectedAt", "inReplyToTweetId", "conversationId", "quotedTweetAuthorId", "retweetCount", "likeCount", "replyCount", "foreignVideoSourceCount", "isReply", "isAuthorReply", "isRetweet", "isPromoted", "isPaidPromotion", "cardDestinationUrlsEvaluated", "hasMedia", "hasAiGeneratedMedia", "quotedTweetHasVideo", "aiGeneratedDetectionSource", "expandedUrls", "cardDestinationUrls", "fullText"
-- scope: accountId
-- from: Tweet
-- big: ctid
-- format: text
-- router: tweet
SELECT
  :part_expr,
  t."id"::bigint,
  t."accountId"::bigint,
  t."createdAt" AT TIME ZONE 'UTC',
  t."collectedAt" AT TIME ZONE 'UTC',
  t."inReplyToTweetId"::bigint,
  t."conversationId"::bigint,
  t."quotedTweetAuthorId"::bigint,
  t."retweetCount",
  t."likeCount",
  t."replyCount",
  CASE WHEN t."foreignVideoSourceCount" IS NULL AND t."collectedAt" >= :'fv_since'::timestamp
       THEN 0 ELSE t."foreignVideoSourceCount" END,
  t."isReply",
  t."isAuthorReply",
  t."isRetweet",
  t."isPromoted",
  t."isPaidPromotion",
  t."cardDestinationUrlsEvaluated",
  CASE WHEN t."hasMedia" IS NULL AND t."collectedAt" >= :'hm_since'::timestamp
       THEN false ELSE t."hasMedia" END,
  t."hasAiGeneratedMedia",
  t."quotedTweetHasVideo",
  t."aiGeneratedDetectionSource",
  NULLIF(t."expandedUrls", '{}'),
  NULLIF(t."cardDestinationUrls", '{}'),
  t."fullText"
FROM "Tweet" t
WHERE :scope
