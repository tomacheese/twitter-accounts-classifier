-- DropIndex
-- CONCURRENTLY で "AccountLabel" への crawler の書き込みをロックせずに削除する。
-- 単一ステートメントのみ許可 (CONCURRENTLY はトランザクション内で実行できない)。
-- relabel.ts の loadLatestRuleVersions は AccountLabelLatest を読むよう変更済みのため、
-- このインデックスの唯一の用途がなくなった。
DROP INDEX CONCURRENTLY IF EXISTS "AccountLabel_accountId_labelDefinitionId_labeledAt_id_idx";
