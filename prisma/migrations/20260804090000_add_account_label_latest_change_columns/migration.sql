-- AccountLabelLatest に評価結果のスナップショット列を追加する。crawler/db/label-repository.ts の
-- 書き込み経路は以降、この列を使って直前の評価と比較し、AccountLabel への履歴 INSERT を変化があった場合のみに限定する。

-- AlterTable
ALTER TABLE "AccountLabelLatest"
  ADD COLUMN "confidence" DOUBLE PRECISION,
  ADD COLUMN "reason" TEXT,
  ADD COLUMN "method" TEXT,
  ADD COLUMN "ruleVersion" TEXT;

-- 既存履歴からの一度限りのバックフィル。(accountId, labelDefinitionId) ごとの最新行を、
-- AccountLabelLatest の作成時と同じ基準 (labeledAt DESC, id DESC) で選び、新カラムに補う。
UPDATE "AccountLabelLatest" al
SET "confidence" = latest."confidence",
    "reason" = latest."reason",
    "method" = latest."method",
    "ruleVersion" = latest."ruleVersion"
FROM (
  SELECT DISTINCT ON ("accountId", "labelDefinitionId")
    "accountId", "labelDefinitionId", "confidence", "reason", "method", "ruleVersion"
  FROM "AccountLabel"
  ORDER BY "accountId", "labelDefinitionId", "labeledAt" DESC, "id" DESC
) latest
WHERE al."accountId" = latest."accountId" AND al."labelDefinitionId" = latest."labelDefinitionId";

-- バックフィルが一部の行を取り残していないことを確認する。
-- 取り残しがあると直後の NOT NULL 制約付与が失敗するため、原因調査しやすいメッセージを先に出す。
DO $$
DECLARE
  remaining_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO remaining_count FROM "AccountLabelLatest" WHERE "ruleVersion" IS NULL;
  IF remaining_count > 0 THEN
    RAISE EXCEPTION 'AccountLabelLatest backfill left % row(s) without a ruleVersion; AccountLabel history may be missing rows for some (accountId, labelDefinitionId) pairs', remaining_count;
  END IF;
END $$;

-- AlterTable
ALTER TABLE "AccountLabelLatest"
  ALTER COLUMN "confidence" SET NOT NULL,
  ALTER COLUMN "reason" SET NOT NULL,
  ALTER COLUMN "method" SET NOT NULL,
  ALTER COLUMN "ruleVersion" SET NOT NULL;
