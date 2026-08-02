-- DropIndex
-- CONCURRENTLY で "AccountLabel" への書き込みをロックせずに削除する。単一ステートメント
-- のみ許可 (CONCURRENTLY はトランザクション内で実行できない)。削除理由は
-- prisma/schema.prisma の AccountLabel.accountId インデックスコメント、Issue #21 を参照。
-- このインデックスは AccountLabel_labelDefinitionId_fkey の被参照側も兼ねていたため、
-- 削除後は LabelDefinition 側の DELETE/UPDATE 時に本テーブルを全走査でロックするが、
-- 該当する削除/キー変更経路は現状存在しない。
DROP INDEX CONCURRENTLY IF EXISTS "AccountLabel_labelDefinitionId_idx";
