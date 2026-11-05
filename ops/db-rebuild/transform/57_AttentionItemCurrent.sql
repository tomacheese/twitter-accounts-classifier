-- target: "AttentionItemCurrent"
-- columns: "generationId", "sourceType", "sourceId", "category", "priority", "severity", "summary", "impact", "detectedAt", "freshness", "detailHref"
-- scope: none
-- big: no
SELECT
  t."generationId",
  t."sourceType",
  t."sourceId",
  t."category",
  t."priority",
  t."severity",
  t."summary",
  t."impact",
  t."detectedAt" AT TIME ZONE 'UTC',
  t."freshness",
  t."detailHref"
FROM "AttentionItemCurrent" t
WHERE :scope
