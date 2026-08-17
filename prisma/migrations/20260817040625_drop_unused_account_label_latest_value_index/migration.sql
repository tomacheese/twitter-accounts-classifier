-- DropIndex
-- CONCURRENTLY で relabel/crawl の書き込みをロックせずに削除する。
-- 単一ステートメントのみ許可 (CONCURRENTLY はトランザクション内で実行できない)。
-- pg_stat_user_indexes で稼働 3 日間の idx_scan が 1 (実質未使用) だったことを確認済み。
-- dashboard.ts など読み取り側は既に AccountClassificationLatest read-model へ移行済みで、
-- このインデックスの唯一の用途がなくなったが、AccountLabelLatest への全書き込みで
-- 更新コストだけを払い続けていた。
DROP INDEX CONCURRENTLY IF EXISTS "AccountLabelLatest_labelDefinitionId_value_idx";
