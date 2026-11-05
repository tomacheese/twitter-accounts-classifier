-- target: "CrawlAccountRun"
-- columns: "id", "crawlRunId", "username", "startedAt", "finishedAt", "status", "recommendedCount", "followingCount", "trendingCount", "replyCount", "profileCount", "labelsAppliedCount", "parentTweetFetchCount", "followingSynced", "followersSynced", "blocksSynced", "warnings", "errorMessage", "appVersion", "classificationStatus"
-- scope: none
-- big: no
SELECT
  t."id",
  t."crawlRunId",
  t."username",
  t."startedAt" AT TIME ZONE 'UTC',
  t."finishedAt" AT TIME ZONE 'UTC',
  t."status",
  t."recommendedCount",
  t."followingCount",
  t."trendingCount",
  t."replyCount",
  t."profileCount",
  t."labelsAppliedCount",
  t."parentTweetFetchCount",
  t."followingSynced",
  t."followersSynced",
  t."blocksSynced",
  t."warnings",
  t."errorMessage",
  t."appVersion",
  t."classificationStatus"
FROM "CrawlAccountRun" t
WHERE :scope
