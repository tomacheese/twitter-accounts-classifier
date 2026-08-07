import type { AnalysisWorkItem, PrismaClient } from './generated/prisma'
import { claimNextWorkItem, completeWorkItem } from './queue/work-item-repository'

const HANDLED_KINDS = [
  'label_metrics',
  'finding_generation',
  'read_model_refresh',
  'weekly_review_ingest',
  'block_reconciliation',
] as const

export interface WorkerLoopDeps {
  leaseOwner: string
  leaseDurationMs?: number
  processLabelMetrics: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  processFindingGeneration: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  processReadModelRefresh: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  processWeeklyReviewIngest: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
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
 * 処理が例外を投げても worker プロセス自体は落とさず、`attemptCount` が
 * `maxAttempts` に達していれば `dead`、そうでなければ再試行対象の `failed` として記録する。
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
    await completeWorkItem(prisma, {
      workItemId: workItem.id,
      leaseOwner: deps.leaseOwner,
      status: 'succeeded',
    })
  } catch (error) {
    const status = workItem.attemptCount >= workItem.maxAttempts ? 'dead' : 'failed'
    await completeWorkItem(prisma, {
      workItemId: workItem.id,
      leaseOwner: deps.leaseOwner,
      status,
      errorSummary: String(error),
    })
  }

  return true
}
