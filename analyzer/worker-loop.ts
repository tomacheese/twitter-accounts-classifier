import type { AnalysisWorkItem, PrismaClient } from './generated/prisma'
import {
  deadLetterExhaustedWorkItem,
  claimNextWorkItem,
  completeWorkItem,
  renewWorkItemLease,
  computeRetryBackoffMs,
  enqueueWorkItem,
  finishAnalysisRun,
  startAnalysisRun,
} from './queue/work-item-repository'
import { LabelAggregateRefreshError } from './worker-processors'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:worker-loop')

/** onWorkItemSettled 失敗時に再試行を委ねる後続 WorkItem の kind。 */
export const POST_COMPLETION_REFRESH_KIND = 'post_completion_refresh'
/** post_completion_refresh WorkItem が指す、完了済み元 WorkItem の triggerType。 */
export const WORK_ITEM_COMPLETION_TRIGGER_TYPE = 'work_item_completion'

const HANDLED_KINDS = [
  'label_aggregate_refresh',
  'read_model_refresh',
  'weekly_review_ingest',
  'block_reconciliation',
  'retention_sweep',
  'account_summary_refresh',
  'account_summary_bootstrap',
  POST_COMPLETION_REFRESH_KIND,
] as const

/**
 * worker ループが必要とする lease 情報と kind ごとの処理関数。
 */
export interface WorkerLoopDeps {
  /** claim した worker を識別する文字列。 */
  leaseOwner: string
  /** lease 更新専用 Prisma client。処理用 pool と分離して長時間 query の影響を受けない。 */
  leasePrisma?: PrismaClient
  /** lease の有効期間 (ミリ秒)。 */
  leaseDurationMs?: number
  /** lease 更新間隔 (ミリ秒)。テストや特殊運用向け。既定は leaseDurationMs の 1/3。 */
  leaseRenewIntervalMs?: number
  /** kind: read_model_refresh の処理関数。 */
  processReadModelRefresh: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: label_aggregate_refresh の処理関数。 */
  processLabelAggregateRefresh: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: weekly_review_ingest の処理関数。 */
  processWeeklyReviewIngest: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: block_reconciliation の処理関数。 */
  processBlockReconciliation: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: retention_sweep の処理関数。 */
  processRetentionSweep: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: post_completion_refresh の処理関数。 */
  processPostCompletionRefresh: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: account_summary_refresh, triggerType: account_classification_observation の処理関数。 */
  processAccountSummaryRefresh: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: account_summary_refresh, triggerType: review_finding_occurrence の処理関数。 */
  processAccountFindingRefresh: (prisma: PrismaClient, workItem: AnalysisWorkItem) => Promise<void>
  /** kind: account_summary_bootstrap の処理関数。 */
  processAccountSummaryBootstrap: (
    prisma: PrismaClient,
    workItem: AnalysisWorkItem,
  ) => Promise<void>
  /**
   * WorkItem の終了状態を確定させた後に呼ばれる後処理。
   * Cycle の再計算は WorkItem の状態が確定した後でなければ最新の Stage 状態を
   * 反映できないため、処理関数の内側ではなくここへ置く。
   */
  onWorkItemSettled?: (
    prisma: PrismaClient,
    workItem: AnalysisWorkItem,
    outcome: WorkItemOutcome,
  ) => Promise<void>
}

/** WorkItem 1 attempt の終了状態。 */
export interface WorkItemOutcome {
  status: 'succeeded' | 'failed' | 'dead'
  errorCode?: string
  errorSummary?: string
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
    case 'read_model_refresh': {
      return deps.processReadModelRefresh(prisma, workItem)
    }
    case 'label_aggregate_refresh': {
      return deps.processLabelAggregateRefresh(prisma, workItem)
    }
    case 'weekly_review_ingest': {
      return deps.processWeeklyReviewIngest(prisma, workItem)
    }
    case 'block_reconciliation': {
      return deps.processBlockReconciliation(prisma, workItem)
    }
    case 'retention_sweep': {
      return deps.processRetentionSweep(prisma, workItem)
    }
    case POST_COMPLETION_REFRESH_KIND: {
      return deps.processPostCompletionRefresh(prisma, workItem)
    }
    case 'account_summary_refresh': {
      if (workItem.triggerType === 'review_finding_occurrence') {
        return deps.processAccountFindingRefresh(prisma, workItem)
      }
      return deps.processAccountSummaryRefresh(prisma, workItem)
    }
    case 'account_summary_bootstrap': {
      return deps.processAccountSummaryBootstrap(prisma, workItem)
    }
    default: {
      throw new Error(`Unknown work item kind: ${workItem.kind}`)
    }
  }
}

async function runPostCompletionHook(
  prisma: PrismaClient,
  deps: WorkerLoopDeps,
  workItem: AnalysisWorkItem,
  outcome: WorkItemOutcome,
): Promise<void> {
  try {
    await deps.onWorkItemSettled?.(prisma, workItem, outcome)
  } catch (error) {
    logger.error(
      `post-completion hook failed for work item ${workItem.id} (${workItem.kind})`,
      error as Error,
    )
    await enqueueWorkItem(prisma, {
      kind: POST_COMPLETION_REFRESH_KIND,
      triggerType: WORK_ITEM_COMPLETION_TRIGGER_TYPE,
      triggerId: workItem.id,
    })
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
  const exhaustedWorkItem = await deadLetterExhaustedWorkItem(prisma, {
    kinds: [...HANDLED_KINDS],
  })
  if (exhaustedWorkItem) {
    await runPostCompletionHook(prisma, deps, exhaustedWorkItem, {
      status: 'dead',
      errorSummary: exhaustedWorkItem.lastErrorSummary ?? undefined,
    })
    return true
  }

  const workItem = await claimNextWorkItem(prisma, {
    kinds: [...HANDLED_KINDS],
    leaseOwner: deps.leaseOwner,
    leaseDurationMs: deps.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
  })
  if (!workItem) return false

  const analysisRunId = await startAnalysisRun(prisma, {
    workItemId: workItem.id,
    attemptNumber: workItem.attemptCount,
  })

  const leaseDurationMs = deps.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS
  const leaseRenewIntervalMs =
    deps.leaseRenewIntervalMs ?? Math.max(1000, Math.floor(leaseDurationMs / 3))
  let renewalPromise: Promise<void> | undefined
  const leaseRenewTimer = setInterval(() => {
    if (renewalPromise) return
    renewalPromise = renewWorkItemLease(deps.leasePrisma ?? prisma, {
      workItemId: workItem.id,
      leaseOwner: deps.leaseOwner,
      leaseDurationMs,
    })
      .then((renewed) => {
        if (!renewed) {
          logger.warn(
            `failed to renew lease for work item ${workItem.id} (${workItem.kind}): lease lost`,
          )
        }
      })
      .catch((error: unknown) => {
        logger.error(
          `lease renewal failed for work item ${workItem.id} (${workItem.kind})`,
          error as Error,
        )
      })
      .finally(() => {
        renewalPromise = undefined
      })
  }, leaseRenewIntervalMs)
  leaseRenewTimer.unref()

  let outcome: WorkItemOutcome
  try {
    await dispatch(prisma, workItem, deps)
    outcome = { status: 'succeeded' }
  } catch (error) {
    logger.error(`work item ${workItem.id} (${workItem.kind}) failed`, error as Error)
    outcome = {
      status: workItem.attemptCount >= workItem.maxAttempts ? 'dead' : 'failed',
      errorCode: error instanceof LabelAggregateRefreshError ? error.errorCode : undefined,
      errorSummary: String(error),
    }
  } finally {
    clearInterval(leaseRenewTimer)
    await renewalPromise
  }

  await finishAnalysisRun(prisma, {
    analysisRunId,
    status: outcome.status,
    errorCode: outcome.errorCode,
    errorSummary: outcome.errorSummary,
  })

  const completed = await completeWorkItem(prisma, {
    workItemId: workItem.id,
    leaseOwner: deps.leaseOwner,
    status: outcome.status,
    errorCode: outcome.errorCode,
    errorSummary: outcome.errorSummary,
    retryAvailableAt: new Date(Date.now() + computeRetryBackoffMs(workItem.attemptCount)),
  })
  if (!completed) {
    logger.warn(
      `discarded ${outcome.status} result for work item ${workItem.id} (${workItem.kind}): lease lost`,
    )
    return true
  }

  // 後処理の失敗で attempt 自体を失敗扱いに巻き戻さず、durable な
  // post_completion_refresh へ委ねる。
  await runPostCompletionHook(prisma, deps, workItem, outcome)

  return true
}
