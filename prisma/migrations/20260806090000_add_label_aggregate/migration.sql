-- 設計意図: prisma/schema.prisma の LabelAggregate/LabelAggregateStatus モデルのコメントを参照。

-- CreateTable
CREATE TABLE "LabelAggregate" (
    "labelDefinitionId" TEXT NOT NULL,
    "labelKey" TEXT NOT NULL,
    "labelDescription" TEXT NOT NULL,
    "trueCount" INTEGER NOT NULL,
    "totalCount" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabelAggregate_pkey" PRIMARY KEY ("labelDefinitionId")
);

-- CreateTable
CREATE TABLE "LabelAggregateStatus" (
    "id" TEXT NOT NULL,
    "labeledAccounts" INTEGER NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastAttemptStatus" TEXT NOT NULL,
    "lastErrorMessage" TEXT,

    CONSTRAINT "LabelAggregateStatus_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LabelAggregate_labelKey_idx" ON "LabelAggregate"("labelKey");

-- AddForeignKey
ALTER TABLE "LabelAggregate" ADD CONSTRAINT "LabelAggregate_labelDefinitionId_fkey" FOREIGN KEY ("labelDefinitionId") REFERENCES "LabelDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
