-- AccountCrawlState。旧 Account の更新頻度の高い 4 列を切り出す。全アカウントに 1 行を作る。
-- recentTweetsFetchStatus は text のまま出力する (enum の binary 形式はラベル文字列そのもの)。
-- target: "AccountCrawlState"
-- columns: "accountId", "lastCrawledAt", "lastRecentTweetsAttemptedAt", "lastRecentTweetsFetchedAt", "recentTweetsFetchStatus"
-- scope: id
-- from: Account
-- big: ctid
SELECT
  t."id"::bigint,
  t."lastCrawledAt" AT TIME ZONE 'UTC',
  t."lastRecentTweetsAttemptedAt" AT TIME ZONE 'UTC',
  t."lastRecentTweetsFetchedAt" AT TIME ZONE 'UTC',
  t."recentTweetsFetchStatus"
FROM "Account" t
WHERE :scope
