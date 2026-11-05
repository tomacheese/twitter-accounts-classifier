-- target: "LabeledAccountCounter"
-- columns: "id", "labeledAccounts", "updatedAt"
-- scope: none
-- big: no
SELECT
  t."id",
  t."labeledAccounts",
  t."updatedAt" AT TIME ZONE 'UTC'
FROM "LabeledAccountCounter" t
WHERE :scope
