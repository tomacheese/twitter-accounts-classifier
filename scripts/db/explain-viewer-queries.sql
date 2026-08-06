-- 現行 Viewer の代表クエリを EXPLAIN (ANALYZE, BUFFERS) で計測するテンプレート。
-- 本番相当環境で読み取り専用ロールを使って実行し、結果は
-- docs/viewer-baseline/explain/ 配下へ実行計画のテキストとしてのみ保存する。
-- 実データの値 (screen name, bio 等) を含む行は保存しない。

-- dashboard.ts の label 集計相当
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT "labelDefinitionId", COUNT(*) FILTER (WHERE "value") AS "trueCount", COUNT(*) AS "evaluatedCount"
FROM "AccountLabelLatest"
GROUP BY "labelDefinitionId";

-- accounts.ts の一覧相当 (offset pagination の実行計画を確認する目的)
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT "id", "screenName", "displayName"
FROM "Account"
ORDER BY "lastCrawledAt" DESC
LIMIT 25 OFFSET 50000;
