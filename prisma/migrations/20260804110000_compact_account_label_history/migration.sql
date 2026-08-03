-- 大量行に対する DELETE はインデックスの肥大化や autovacuum 負荷を招くため、
-- CREATE TABLE ... AS SELECT による重複履歴の圧縮とテーブル入れ替えのほうが安全かつ高速と判断した。
CREATE TABLE "AccountLabel_compacted" AS
SELECT "id", "accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "labeledAt"
FROM (
  SELECT
    *,
    LAG("value") OVER (
      PARTITION BY "accountId", "labelDefinitionId" ORDER BY "labeledAt", "id"
    ) AS "prevValue",
    LAG("ruleVersion") OVER (
      PARTITION BY "accountId", "labelDefinitionId" ORDER BY "labeledAt", "id"
    ) AS "prevRuleVersion"
  FROM "AccountLabel"
) diffed
WHERE "prevValue" IS NULL
   OR "prevValue" IS DISTINCT FROM "value"
   OR "prevRuleVersion" IS DISTINCT FROM "ruleVersion";

-- CREATE TABLE ... AS SELECT は列の NOT NULL 制約およびデフォルト値を引き継がないため明示的に付与する。
ALTER TABLE "AccountLabel_compacted"
  ALTER COLUMN "id" SET NOT NULL,
  ALTER COLUMN "accountId" SET NOT NULL,
  ALTER COLUMN "labelDefinitionId" SET NOT NULL,
  ALTER COLUMN "value" SET NOT NULL,
  ALTER COLUMN "confidence" SET NOT NULL,
  ALTER COLUMN "reason" SET NOT NULL,
  ALTER COLUMN "method" SET NOT NULL,
  ALTER COLUMN "ruleVersion" SET NOT NULL,
  ALTER COLUMN "labeledAt" SET NOT NULL,
  ALTER COLUMN "labeledAt" SET DEFAULT CURRENT_TIMESTAMP;

-- 旧テーブルは安全網として即削除せず、リネームだけ行って残す (次回リリースで別マイグレーションとして削除する)。
ALTER TABLE "AccountLabel" RENAME TO "AccountLabel_pre_compaction";

-- 新テーブル側で元の制約名・インデックス名をそのまま使い回すため、旧テーブル側を先にリネームしておく。
ALTER TABLE "AccountLabel_pre_compaction" RENAME CONSTRAINT "AccountLabel_pkey" TO "AccountLabel_pre_compaction_pkey";
ALTER INDEX "AccountLabel_accountId_idx" RENAME TO "AccountLabel_pre_compaction_accountId_idx";
ALTER TABLE "AccountLabel_pre_compaction" RENAME CONSTRAINT "AccountLabel_accountId_fkey" TO "AccountLabel_pre_compaction_accountId_fkey";
ALTER TABLE "AccountLabel_pre_compaction" RENAME CONSTRAINT "AccountLabel_labelDefinitionId_fkey" TO "AccountLabel_pre_compaction_labelDefinitionId_fkey";

ALTER TABLE "AccountLabel_compacted" RENAME TO "AccountLabel";

ALTER TABLE "AccountLabel" ADD CONSTRAINT "AccountLabel_pkey" PRIMARY KEY ("id");
CREATE INDEX "AccountLabel_accountId_idx" ON "AccountLabel"("accountId");
ALTER TABLE "AccountLabel" ADD CONSTRAINT "AccountLabel_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AccountLabel" ADD CONSTRAINT "AccountLabel_labelDefinitionId_fkey" FOREIGN KEY ("labelDefinitionId") REFERENCES "LabelDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CREATE TABLE ... AS SELECT はプランナー統計を引き継がない。
-- 入れ替え直後の実行計画が古い統計に基づいて劣化するのを避けるため、明示的に ANALYZE する。
ANALYZE "AccountLabel";
