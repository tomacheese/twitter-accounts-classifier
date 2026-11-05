-- stage: AnalysisWorkItem のうち未処理・実行中・dead の行 (完了済みは AnalysisWorkItemDone へ移す)。
-- id は旧 uuid (text) のまま stg に入れ、finalize で createdAt 順に int id を採番する。
-- `status < 'succeeded' OR status > 'succeeded'` は (status, availableAt, priority) のインデックスを使うための書き方。
-- target: stg."AnalysisWorkItem"
-- columns: "id", "kind", "triggerType", "triggerId", "status", "priority", "availableAt", "leaseOwner", "leaseExpiresAt", "attemptCount", "maxAttempts", "dependencyKey", "lastErrorCode", "lastErrorSummary", "createdAt", "updatedAt", "staleRequestedAt"
-- scope: none
-- big: no
SELECT t."id", t."kind", t."triggerType", t."triggerId", t."status", t."priority",
  t."availableAt" AT TIME ZONE 'UTC', t."leaseOwner", t."leaseExpiresAt" AT TIME ZONE 'UTC',
  t."attemptCount", t."maxAttempts", t."dependencyKey", t."lastErrorCode", t."lastErrorSummary",
  t."createdAt" AT TIME ZONE 'UTC', t."updatedAt" AT TIME ZONE 'UTC', t."staleRequestedAt" AT TIME ZONE 'UTC'
FROM "AnalysisWorkItem" t
WHERE (t."status" < 'succeeded' OR t."status" > 'succeeded')
