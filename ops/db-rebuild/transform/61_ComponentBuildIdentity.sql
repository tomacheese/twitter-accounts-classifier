-- target: "ComponentBuildIdentity"
-- columns: "component", "applicationVersion", "gitRevision", "buildTime", "startedAt", "updatedAt"
-- scope: none
-- big: no
SELECT
  t."component",
  t."applicationVersion",
  t."gitRevision",
  t."buildTime" AT TIME ZONE 'UTC',
  t."startedAt" AT TIME ZONE 'UTC',
  t."updatedAt" AT TIME ZONE 'UTC'
FROM "ComponentBuildIdentity" t
WHERE :scope
