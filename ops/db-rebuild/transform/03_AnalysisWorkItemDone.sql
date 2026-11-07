-- stage: 完了済み (succeeded) の論理キーのうち、切り替え時点から過去 30 日分。finalize が AnalysisWorkItemDone へ組み立てる。
-- workItemId は旧 id (text) のまま stg に入れ、finalize で他の表と同じ変換表を通して int id にする。
-- completedAt は旧 updatedAt を使う。30 日の基準 done_cutoff は load.sh が旧 DB のスナップショット時刻から決める。
-- account_relabel は再 arm できる kind で、台帳に記録しない。
-- 論理キー (kind、triggerType、triggerId) は旧 DB で一意のため、重複の除外は要らない。
-- target: stg."AnalysisWorkItemDone"
-- columns: "workItemId", "completedAt", "createdAt", "attemptCount", "kind", "triggerType", "triggerId"
-- scope: none
-- big: no
SELECT t."id", t."updatedAt" AT TIME ZONE 'UTC', t."createdAt" AT TIME ZONE 'UTC', t."attemptCount",
  t."kind", t."triggerType", t."triggerId"
FROM "AnalysisWorkItem" t
WHERE t."status" = 'succeeded'
  AND t."kind" <> 'account_relabel'
  AND t."updatedAt" >= (:'done_cutoff'::timestamp - interval '30 days')
