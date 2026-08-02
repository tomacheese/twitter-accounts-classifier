-- DropIndex
-- CONCURRENTLY で "AccountLabel" への crawler の書き込みをロックせずにインデックスを
-- 削除する。単一ステートメントのみに保つ理由は同ディレクトリ内の
-- drop_account_label_label_definition_id_index マイグレーションのコメントを参照。
-- `labeledAt` 単体を先頭カラムとするソート・絞り込みを行うクエリは存在せず
-- (viewer/lib/queries/account-detail.ts のクエリは accountId で絞り込んでから
-- labeledAt でソートしており、先頭カラムが accountId のインデックスで満たせる)、この
-- 単一カラムインデックスは書き込みコストのみを増やしていたため削除する
-- (詳細は Issue #21)。
DROP INDEX CONCURRENTLY IF EXISTS "AccountLabel_labeledAt_idx";
