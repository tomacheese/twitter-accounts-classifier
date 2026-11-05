-- verify-parity.sh が AccountLabelChange を旧と新で比べるための出力。
-- false 側の確信度と理由は S+ で失われるため、added の previous 側の確信度と理由、removed と unevaluable の new 側の列は比べない。
\pset format unaligned
\pset tuples_only on
SELECT concat_ws('|',
  "accountId", "labelDefinitionId", "changeType",
  coalesce("previousValue"::text, ''), coalesce("newValue"::text, ''),
  CASE WHEN "changeType"::text = 'added' THEN '-' ELSE coalesce("previousConfidence"::text, '') END,
  CASE WHEN "changeType"::text = 'added' THEN '-' ELSE coalesce("previousReason", '') END,
  CASE WHEN "changeType"::text = 'added' THEN coalesce("newConfidence"::text, '') ELSE '-' END,
  CASE WHEN "changeType"::text = 'added' THEN coalesce("newReason", '') ELSE '-' END,
  coalesce("sourceId", ''),
  to_char("changedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))
FROM "AccountLabelChange"
WHERE "accountId"::text IN ('6001', '6002', '6003')
ORDER BY 1;
