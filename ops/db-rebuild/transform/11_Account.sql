-- Account。更新頻度の高い 4 列 (lastCrawledAt など) は AccountCrawlState へ分ける (12_AccountCrawlState.sql)。
-- id は数字だけの文字列を bigint に変換する。数字以外が混じると変換エラーで投入が止まる。
-- target: "Account"
-- columns: "id", "accountCreatedAt", "firstSeenAt", "updatedAt", "followersCount", "followingCount", "tweetCount", "isBlueVerified", "screenName", "displayName", "bio", "profileImageUrl", "location", "url", "verifiedType", "professionalType", "parodyCommentaryFanLabel"
-- scope: id
-- from: Account
-- big: ctid
SELECT
  t."id"::bigint,
  t."accountCreatedAt" AT TIME ZONE 'UTC',
  t."firstSeenAt" AT TIME ZONE 'UTC',
  t."updatedAt" AT TIME ZONE 'UTC',
  t."followersCount",
  t."followingCount",
  t."tweetCount",
  t."isBlueVerified",
  t."screenName",
  t."displayName",
  t."bio",
  t."profileImageUrl",
  t."location",
  t."url",
  t."verifiedType",
  t."professionalType",
  t."parodyCommentaryFanLabel"
FROM "Account" t
WHERE :scope
