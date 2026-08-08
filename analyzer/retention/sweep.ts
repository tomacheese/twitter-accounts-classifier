import type { PrismaClient } from '../generated/prisma'

const ANALYSIS_RUN_RETENTION_DAYS = 180
const LABEL_METRIC_SNAPSHOT_RETENTION_DAYS = 90
const WORK_ITEM_RETENTION_DAYS = 30
const OVERVIEW_SNAPSHOT_RETENTION_DAYS = 30
const SHADOW_DETECTOR_EVALUATION_RETENTION_DAYS = 30

// リトライを使い切って再試行され得なくなった WorkItem。succeeded と同じく
// 完了済みとして 30日retentionの対象にする。
const TERMINAL_WORK_ITEM_STATUSES = ['succeeded', 'dead']

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * @param now - 基準時刻
 * @param days - 遡る日数
 * @returns 基準時刻から days 日前の時刻
 */
function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * DAY_MS)
}

/**
 * 完了済み WorkItem を保持期間に応じて削除する。
 * WorkItem (30日) と AnalysisRun (180日) は保持期間が異なるため、AnalysisRun を
 * cascade delete すると audit 記録が実質 30日しか残らない。AnalysisRun.workItemId は
 * nullable FK (onDelete: SetNull) にしてあり、WorkItem 削除時は参照を外すだけに留め、
 * AnalysisRun 自体は自身の 180日の retention sweep が削除するまで残す。
 * @param prisma - Prisma クライアント
 * @param now - 基準時刻
 * @returns 削除した WorkItem 数
 */
async function sweepWorkItems(
  prisma: PrismaClient,
  now: Date,
): Promise<{ deletedWorkItemCount: number }> {
  const eligibleWorkItems = await prisma.analysisWorkItem.findMany({
    where: {
      status: { in: TERMINAL_WORK_ITEM_STATUSES },
      updatedAt: { lt: daysBefore(now, WORK_ITEM_RETENTION_DAYS) },
    },
    select: { id: true },
  })
  if (eligibleWorkItems.length === 0) return { deletedWorkItemCount: 0 }

  const eligibleWorkItemIds = eligibleWorkItems.map((workItem) => workItem.id)
  const workItemResult = await prisma.analysisWorkItem.deleteMany({
    where: { id: { in: eligibleWorkItemIds } },
  })

  return { deletedWorkItemCount: workItemResult.count }
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
 * shadow 評価の DetectorEvaluation を保持期間に応じて削除する。
 * 本番判定に使う isShadow: false の行は削除せず、無効化前の比較用に積み上げる
 * shadow 行だけを対象にする。
 * @param prisma - Prisma クライアント
 * @param now - 基準時刻
 * @returns 削除した行数
 */
async function sweepShadowDetectorEvaluations(prisma: PrismaClient, now: Date): Promise<number> {
  const result = await prisma.detectorEvaluation.deleteMany({
    where: {
      isShadow: true,
      evaluatedAt: { lt: daysBefore(now, SHADOW_DETECTOR_EVALUATION_RETENTION_DAYS) },
    },
  })
  return result.count
}

/** runRetentionSweep の結果。 */
export interface RetentionSweepResult {
  deletedAnalysisRunCount: number
  deletedWorkItemCount: number
  deletedLabelMetricSnapshotCount: number
  deletedOverviewSnapshotCount: number
  deletedShadowDetectorEvaluationCount: number
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
  const deletedShadowDetectorEvaluationCount = await sweepShadowDetectorEvaluations(prisma, now)

  return {
    deletedAnalysisRunCount: analysisRunResult.count,
    deletedWorkItemCount: workItemSweepResult.deletedWorkItemCount,
    deletedLabelMetricSnapshotCount: labelMetricSnapshotResult.count,
    deletedOverviewSnapshotCount,
    deletedShadowDetectorEvaluationCount,
  }
}
