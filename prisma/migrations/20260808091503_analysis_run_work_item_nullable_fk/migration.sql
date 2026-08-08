-- WorkItem (30日) と AnalysisRun (180日) は保持期間が異なる。cascade delete のままだと
-- WorkItem の retention sweep のたびに紐づく AnalysisRun も年齢を問わず消えてしまうため、
-- workItemId を nullable にし、WorkItem 削除時は参照を外すだけに留める (ON DELETE SET NULL)。

-- DropForeignKey
ALTER TABLE "AnalysisRun" DROP CONSTRAINT "AnalysisRun_workItemId_fkey";

-- AlterTable
ALTER TABLE "AnalysisRun" ALTER COLUMN "workItemId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "AnalysisRun" ADD CONSTRAINT "AnalysisRun_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "AnalysisWorkItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
