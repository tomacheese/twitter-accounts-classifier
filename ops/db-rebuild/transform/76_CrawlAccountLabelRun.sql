-- target: "CrawlAccountLabelRun"
-- columns: "id", "crawlRunId", "username", "accountId", "labelDefinitionId", "method", "ruleVersion", "createdAt"
-- scope: accountId
-- big: no
SELECT
  t."id",
  t."crawlRunId",
  t."username",
  t."accountId"::bigint,
  (:'lmap'::jsonb ->> t."labelDefinitionId")::smallint,
  t."method",
  t."ruleVersion",
  t."createdAt" AT TIME ZONE 'UTC'
FROM "CrawlAccountLabelRun" t
WHERE :scope
