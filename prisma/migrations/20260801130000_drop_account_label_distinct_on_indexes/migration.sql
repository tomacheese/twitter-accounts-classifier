-- DropIndex
-- CONCURRENTLY で "AccountLabel" への crawler の書き込みをロックせずにインデックスを
-- 削除する。Prisma Migrate はファイルが単一ステートメントのときのみトランザクションで
-- 包まずに実行する (CONCURRENTLY はトランザクション内では実行できない) ため、この
-- マイグレーションは必ず1ステートメントのままにすること。直前のマイグレーションで
-- ダッシュボードの DISTINCT ON クエリを "AccountLabelLatest" 側へ移したため、
-- このインデックスを使う DISTINCT ON クエリはコードベースにもう存在しない。
DROP INDEX CONCURRENTLY IF EXISTS "AccountLabel_accountId_labelDefinitionId_labeledAt_idx";
