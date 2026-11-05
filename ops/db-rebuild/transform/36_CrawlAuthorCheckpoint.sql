-- target: "CrawlAuthorCheckpoint"
-- columns: "id", "crawlRunId", "username", "authorId", "status", "profileCount", "labelsAppliedCount", "warnings", "durationMs", "retryWaitMs", "followSampleStatus", "followSampleRequestCount", "followSampleRateLimitRemaining", "followSampleRateLimitReset", "parentTweetFetchRequestCount", "parentTweetFetchRateLimitRemaining", "parentTweetFetchRateLimitReset", "appVersion", "completedAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."crawlRunId",
  t."username",
  t."authorId"::bigint,
  t."status",
  t."profileCount",
  t."labelsAppliedCount",
  t."warnings",
  t."durationMs",
  t."retryWaitMs",
  t."followSampleStatus",
  t."followSampleRequestCount",
  t."followSampleRateLimitRemaining",
  t."followSampleRateLimitReset",
  t."parentTweetFetchRequestCount",
  t."parentTweetFetchRateLimitRemaining",
  t."parentTweetFetchRateLimitReset",
  t."appVersion",
  t."completedAt" AT TIME ZONE 'UTC'
FROM "CrawlAuthorCheckpoint" t
WHERE :scope
