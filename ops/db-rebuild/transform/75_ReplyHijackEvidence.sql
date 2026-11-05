-- target: "ReplyHijackEvidence"
-- columns: "id", "accountId", "targetTweetId", "ruleVersion", "observedAt", "swarmSize", "averageSimilarity", "spanHours", "replyTweetIds"
-- scope: accountId
-- big: no
SELECT
  t."id",
  t."accountId"::bigint,
  t."targetTweetId"::bigint,
  t."ruleVersion",
  t."observedAt" AT TIME ZONE 'UTC',
  t."swarmSize",
  t."averageSimilarity",
  t."spanHours",
  t."replyTweetIds"::bigint[]
FROM "ReplyHijackEvidence" t
WHERE :scope
