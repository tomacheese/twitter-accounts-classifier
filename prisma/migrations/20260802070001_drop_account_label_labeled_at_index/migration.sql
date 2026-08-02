-- DropIndex
-- CONCURRENTLY で "AccountLabel" への書き込みをロックせずに削除する。単一ステートメントのみ
-- 許可する理由は隣の 20260802070000 マイグレーションのコメントを参照。削除理由は
-- prisma/schema.prisma の AccountLabel.accountId インデックスコメント、Issue #21 を参照
-- (account-detail.ts のクエリは accountId で絞ってからソートするため accountId 単体の
-- インデックスで足りる)。
DROP INDEX CONCURRENTLY IF EXISTS "AccountLabel_labeledAt_idx";
