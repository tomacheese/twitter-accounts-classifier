-- target: "ReviewFindingOccurrence"
-- columns: "id", "findingId", "observedAt", "sourceObservedAt", "stateTransition", "severity", "sourceType", "sourceId", "observedValue", "baselineValue", "absoluteDifference", "relativeDifference", "affectedCount", "totalCount", "affectedRatio", "consecutiveCount", "confidence", "thresholds", "measurements", "policyHash", "detectorVersion", "observationKey"
-- scope: none
-- big: no
SELECT
  t."id",
  t."findingId",
  t."observedAt" AT TIME ZONE 'UTC',
  t."sourceObservedAt" AT TIME ZONE 'UTC',
  t."stateTransition",
  t."severity",
  t."sourceType",
  t."sourceId",
  t."observedValue",
  t."baselineValue",
  t."absoluteDifference",
  t."relativeDifference",
  t."affectedCount",
  t."totalCount",
  t."affectedRatio",
  t."consecutiveCount",
  t."confidence",
  t."thresholds",
  t."measurements",
  t."policyHash",
  t."detectorVersion",
  t."observationKey"
FROM "ReviewFindingOccurrence" t
WHERE :scope
