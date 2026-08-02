-- DropIndex
-- CONCURRENTLY で "AccountLabel" への crawler の書き込みをロックせずにインデックスを
-- 削除する。Prisma Migrate はファイルが単一ステートメントのときのみトランザクションで
-- 包まずに実行する (CONCURRENTLY はトランザクション内では実行できない) ため、この
-- マイグレーションは必ず1ステートメントのままにすること。リポジトリ内のクエリを調査
-- した結果、`labelDefinitionId` 単体を先頭カラムとする絞り込みを行うクエリは存在せず
-- (AccountLabelLatest 側の同名カラムとは別のインデックスである)、この単一カラム
-- インデックスは書き込みコストのみを増やしていたため削除する (詳細は Issue #21)。
DROP INDEX CONCURRENTLY IF EXISTS "AccountLabel_labelDefinitionId_idx";
