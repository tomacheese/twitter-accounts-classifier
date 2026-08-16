-- DropForeignKey
ALTER TABLE "LabelAggregate" DROP CONSTRAINT "LabelAggregate_labelDefinitionId_fkey";

-- DropTable
DROP TABLE "LabelAggregate";

-- DropTable
DROP TABLE "LabelAggregateStatus";
