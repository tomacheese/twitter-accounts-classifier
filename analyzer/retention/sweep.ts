import type { PrismaClient } from '../generated/prisma'

const ANALYSIS_RUN_RETENTION_DAYS = 180
const LABEL_METRIC_SNAPSHOT_RETENTION_DAYS = 90
const WORK_ITEM_RETENTION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * @param now - 基準時刻
 * @param days - 遡る日数
 * @returns 基準時刻から days 日前の時刻
 */
function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS)
}

/** runRetentionSweep の結果。 */
export interface RetentionSweepResult {
  deletedAnalysisRunCount: number
  deletedWorkItemCount: number
  deletedLabelMetricSnapshotCount: number
}

/**
 * analyzer が積み上げる履歴テーブルを保持期間に応じて削除する。
 * AnalysisWorkItem は AnalysisRun への実 FK を持つため、
 * 先に AnalysisRun を削除しないと参照中の WorkItem 削除が外部キー制約に失敗する。
 * そのため WorkItem 側は「削除対象期間を過ぎていて、かつ参照する AnalysisRun が
 * 既に無い」行だけを対象にし、AnalysisRun の保持期間 (180日) より短い
 * WorkItem の保持期間 (30日) を機械的に強制しない。
 * @param prisma - Prisma クライアント
 * @param now - 基準時刻
 * @returns 削除した行数
 */
export async function runRetentionSweep(
  prisma: PrismaClient,
  now: Date,
): Promise<RetentionSweepResult> {
  const analysisRunResult = await prisma.analysisRun.deleteMany({
    where: { finishedAt: { lt: daysBefore(now, ANALYSIS_RUN_RETENTION_DAYS) } },
  })

  const workItemResult = await prisma.analysisWorkItem.deleteMany({
    where: {
      status: 'succeeded',
      updatedAt: { lt: daysBefore(now, WORK_ITEM_RETENTION_DAYS) },
      runs: { none: {} },
    },
  })

  const labelMetricSnapshotResult = await prisma.labelMetricSnapshot.deleteMany({
    where: { observedAt: { lt: daysBefore(now, LABEL_METRIC_SNAPSHOT_RETENTION_DAYS) } },
  })

  return {
    deletedAnalysisRunCount: analysisRunResult.count,
    deletedWorkItemCount: workItemResult.count,
    deletedLabelMetricSnapshotCount: labelMetricSnapshotResult.count,
  }
}
