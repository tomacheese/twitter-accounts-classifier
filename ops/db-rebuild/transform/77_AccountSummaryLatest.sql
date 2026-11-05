-- target: "AccountSummaryLatest"
-- columns: "accountId", "normalizedScreenName", "normalizedDisplayName", "searchDocument", "profileObservedAt", "activeLabelKeys", "activeLabelCount", "lastClassificationChangedAt", "classificationObservedAt", "activeFindingCount", "highestFindingSeverity", "findingObservedAt", "updatedAt"
-- scope: accountId
-- big: no
SELECT
  t."accountId"::bigint,
  t."normalizedScreenName",
  t."normalizedDisplayName",
  t."searchDocument",
  t."profileObservedAt" AT TIME ZONE 'UTC',
  t."activeLabelKeys",
  t."activeLabelCount",
  t."lastClassificationChangedAt" AT TIME ZONE 'UTC',
  t."classificationObservedAt" AT TIME ZONE 'UTC',
  t."activeFindingCount",
  t."highestFindingSeverity",
  t."findingObservedAt" AT TIME ZONE 'UTC',
  t."updatedAt" AT TIME ZONE 'UTC'
FROM "AccountSummaryLatest" t
WHERE :scope
