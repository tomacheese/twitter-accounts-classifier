import type { AnalysisWorkItem, PrismaClient } from './generated/prisma'
import { claimNextWorkItem, completeWorkItem } from './queue/work-item-repository'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:worker-loop')

const HANDLED_KINDS = [
  'label_metrics',
  'finding_generation',
  'read_model_refresh',
  'weekly_review_ingest',
  'block_reconciliation',
] as const

/**
 * worker ループが必要とする lease 情報と kind ごとの処理関数。
 */
export interface WorkerLoopDeps {
  /** claim した worker を識別する文字列。 */
  leaseOwner: string
  /** lease の有効期間 (ミリ秒)。 */
  leaseDurationMs?: number
  /** kind: label_metrics の処理関数。 */
  processLabelMetrics: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: finding_generation の処理関数。 */
  processFindingGeneration: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: read_model_refresh の処理関数。 */
  processReadModelRefresh: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: weekly_review_ingest の処理関数。 */
  processWeeklyReviewIngest: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: block_reconciliation の処理関数。 */
  processBlockReconciliation: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
}

const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000

/**
 * @param prisma - Prisma クライアント
 * @param workItem - claim した WorkItem
 * @param deps - kind ごとの処理関数
 */
async function dispatch(
  prisma: PrismaClient,
  workItem: AnalysisWorkItem,
  deps: WorkerLoopDeps,
): Promise<void> {
  switch (workItem.kind) {
    case 'label_metrics': {
      return deps.processLabelMetrics(prisma, workItem)
    }
    case 'finding_generation': {
      return deps.processFindingGeneration(prisma, workItem)
    }
    case 'read_model_refresh': {
      return deps.processReadModelRefresh(prisma, workItem)
    }
    case 'weekly_review_ingest': {
      return deps.processWeeklyReviewIngest(prisma, workItem)
    }
    case 'block_reconciliation': {
      return deps.processBlockReconciliation(prisma, workItem)
    }
    default: {
      throw new Error(`Unknown work item kind: ${workItem.kind}`)
    }
  }
}

/**
 * WorkItem を 1 件 claim し、kind に応じた処理関数を呼び分けて結果を記録する。
 * 処理が例外を投げても worker プロセス自体は落とさない。
 * `attemptCount` が `maxAttempts` に達していれば `dead`、
 * そうでなければ再試行対象の `failed` として記録する。
 * @param prisma - Prisma クライアント
 * @param deps - lease owner と kind ごとの処理関数
 * @returns 処理対象があれば true、queue が空なら false
 */
export async function runWorkerLoopOnce(
  prisma: PrismaClient,
  deps: WorkerLoopDeps,
): Promise<boolean> {
  const workItem = await claimNextWorkItem(prisma, {
    kinds: [...HANDLED_KINDS],
    leaseOwner: deps.leaseOwner,
    leaseDurationMs: deps.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
  })
  if (!workItem) return false

  try {
    await dispatch(prisma, workItem, deps)
    const completed = await completeWorkItem(prisma, {
      workItemId: workItem.id,
      leaseOwner: deps.leaseOwner,
      status: 'succeeded',
    })
    if (!completed) {
      logger.warn(
        `discarded succeeded result for work item ${workItem.id} (${workItem.kind}): lease lost`,
      )
    }
  } catch (error) {
    logger.error(`work item ${workItem.id} (${workItem.kind}) failed`, error as Error)
    const status = workItem.attemptCount >= workItem.maxAttempts ? 'dead' : 'failed'
    const completed = await completeWorkItem(prisma, {
      workItemId: workItem.id,
      leaseOwner: deps.leaseOwner,
      status,
      errorSummary: String(error),
    })
    if (!completed) {
      logger.warn(
        `discarded ${status} result for work item ${workItem.id} (${workItem.kind}): lease lost`,
      )
    }
  }

  return true
}
