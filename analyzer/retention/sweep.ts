import type { PrismaClient } from '../generated/prisma'

const ANALYSIS_RUN_RETENTION_DAYS = 180
const LABEL_METRIC_SNAPSHOT_RETENTION_DAYS = 90
const WORK_ITEM_RETENTION_DAYS = 30
const OVERVIEW_SNAPSHOT_RETENTION_DAYS = 30

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
  deletedOverviewSnapshotCount: number
}

/**
 * 完了済み WorkItem を保持期間に応じて削除する。
 * AnalysisWorkItem は AnalysisRun への実 FK を持つため、参照中の AnalysisRun が
 * 残っていると削除が外部キー制約に失敗する。WorkItem 自身の保持期間 (30日) を
 * AnalysisRun の保持期間 (180日) より優先させるため、削除対象の WorkItem に紐づく
 * AnalysisRun は年齢を問わず先に削除する。それらの AnalysisRun は親の WorkItem が
 * 削除された時点で audit 対象としての意味を失うため、180日の保持期間より早く
 * 消えても構わない。
 * @param prisma - Prisma クライアント
 * @param now - 基準時刻
 * @returns 削除した AnalysisRun 数と WorkItem 数
 */
async function sweepWorkItems(
  prisma: PrismaClient,
  now: Date,
): Promise<{ deletedAnalysisRunCount: number; deletedWorkItemCount: number }> {
  const eligibleWorkItems = await prisma.analysisWorkItem.findMany({
    where: { status: 'succeeded', updatedAt: { lt: daysBefore(now, WORK_ITEM_RETENTION_DAYS) } },
    select: { id: true },
  })
  if (eligibleWorkItems.length === 0) return { deletedAnalysisRunCount: 0, deletedWorkItemCount: 0 }

  const eligibleWorkItemIds = eligibleWorkItems.map((workItem) => workItem.id)
  const cascadedAnalysisRunResult = await prisma.analysisRun.deleteMany({
    where: { workItemId: { in: eligibleWorkItemIds } },
  })
  const workItemResult = await prisma.analysisWorkItem.deleteMany({
    where: { id: { in: eligibleWorkItemIds } },
  })

  return {
    deletedAnalysisRunCount: cascadedAnalysisRunResult.count,
    deletedWorkItemCount: workItemResult.count,
  }
}

/**
 * OverviewSnapshot を保持期間に応じて削除する。
 * 世代公開のたびに前世代までしか残さない他の read model と異なり、
 * Overview は trend 表示のために日数単位の履歴を残す設計のため、
 * 現在参照中の generation を除いて日数だけで判定する。
 * @param prisma - Prisma クライアント
 * @param now - 基準時刻
 * @returns 削除した行数
 */
async function sweepOverviewSnapshots(prisma: PrismaClient, now: Date): Promise<number> {
  const pointer = await prisma.readModelPointer.findUnique({
    where: { modelKey: 'overview_snapshot' },
    select: { currentGenerationId: true },
  })

  const result = await prisma.overviewSnapshot.deleteMany({
    where: {
      generatedAt: { lt: daysBefore(now, OVERVIEW_SNAPSHOT_RETENTION_DAYS) },
      generationId: { not: pointer?.currentGenerationId ?? '' },
    },
  })
  return result.count
}

/**
 * analyzer が積み上げる履歴テーブルを保持期間に応じて削除する。
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

  const workItemSweepResult = await sweepWorkItems(prisma, now)

  const labelMetricSnapshotResult = await prisma.labelMetricSnapshot.deleteMany({
    where: { observedAt: { lt: daysBefore(now, LABEL_METRIC_SNAPSHOT_RETENTION_DAYS) } },
  })

  const deletedOverviewSnapshotCount = await sweepOverviewSnapshots(prisma, now)

  return {
    deletedAnalysisRunCount: analysisRunResult.count + workItemSweepResult.deletedAnalysisRunCount,
    deletedWorkItemCount: workItemSweepResult.deletedWorkItemCount,
    deletedLabelMetricSnapshotCount: labelMetricSnapshotResult.count,
    deletedOverviewSnapshotCount,
  }
}
