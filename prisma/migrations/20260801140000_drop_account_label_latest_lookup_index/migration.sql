-- DropIndex
-- 同じ理由で単一ステートメントのまま CONCURRENTLY を使う (前のマイグレーションの
-- コメントを参照)。こちらも DISTINCT ON クエリの ORDER BY に "id" 列まで含めて
-- 一致させるためだけに追加したインデックスで、対応するクエリがなくなったため不要。
DROP INDEX CONCURRENTLY IF EXISTS "AccountLabel_accountId_labelDefinitionId_labeledAt_id_idx";
