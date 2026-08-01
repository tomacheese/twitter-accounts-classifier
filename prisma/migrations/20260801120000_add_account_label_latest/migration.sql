-- 設計意図: prisma/schema.prisma の AccountLabelLatest モデルのコメントを参照。

-- CreateTable
CREATE TABLE "AccountLabelLatest" (
    "accountId" TEXT NOT NULL,
    "labelDefinitionId" TEXT NOT NULL,
    "value" BOOLEAN NOT NULL,
    "labeledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountLabelLatest_pkey" PRIMARY KEY ("accountId","labelDefinitionId")
);

-- CreateIndex
CREATE INDEX "AccountLabelLatest_labelDefinitionId_idx" ON "AccountLabelLatest"("labelDefinitionId");

-- CreateIndex
CREATE INDEX "AccountLabelLatest_labelDefinitionId_value_idx" ON "AccountLabelLatest"("labelDefinitionId", "value");

-- CreateIndex
CREATE INDEX "AccountLabelLatest_value_accountId_idx" ON "AccountLabelLatest"("value", "accountId");

-- AddForeignKey
ALTER TABLE "AccountLabelLatest" ADD CONSTRAINT "AccountLabelLatest_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountLabelLatest" ADD CONSTRAINT "AccountLabelLatest_labelDefinitionId_fkey" FOREIGN KEY ("labelDefinitionId") REFERENCES "LabelDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 既存履歴からの一度限りのバックフィル: これまでダッシュボードがページロード
-- のたびに実行していたのと同じクエリを、このマイグレーション実行時に一度だけ
-- 流す。これ以降のすべての書き込みは recordAccountLabel の1行 upsert を経由
-- する。
INSERT INTO "AccountLabelLatest" ("accountId", "labelDefinitionId", "value", "labeledAt")
SELECT DISTINCT ON ("accountId", "labelDefinitionId")
  "accountId", "labelDefinitionId", "value", "labeledAt"
FROM "AccountLabel"
ORDER BY "accountId", "labelDefinitionId", "labeledAt" DESC, "id" DESC;
