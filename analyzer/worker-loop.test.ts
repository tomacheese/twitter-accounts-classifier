import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AnalysisWorkItem, PrismaClient } from './generated/prisma'
import {
  runWorkerLoopOnce,
  POST_COMPLETION_REFRESH_KIND,
  WORK_ITEM_COMPLETION_TRIGGER_TYPE,
} from './worker-loop'

const claimNextWorkItem = vi.fn()
const completeWorkItem = vi.fn()
const enqueueWorkItem = vi.fn()
const startAnalysisRun = vi.fn()
const finishAnalysisRun = vi.fn()
const loggerWarn = vi.fn()
const loggerError = vi.fn()

vi.mock('@book000/node-utils', () => ({
  Logger: {
    configure: () => ({
      warn: (...args: unknown[]): unknown => loggerWarn(...args) as unknown,
      error: (...args: unknown[]): unknown => loggerError(...args) as unknown,
      info: vi.fn(),
      debug: vi.fn(),
    }),
  },
}))

vi.mock('./queue/work-item-repository', () => ({
  claimNextWorkItem: (...args: unknown[]): unknown => claimNextWorkItem(...args) as unknown,
  completeWorkItem: (...args: unknown[]): unknown => completeWorkItem(...args) as unknown,
  enqueueWorkItem: (...args: unknown[]): unknown => enqueueWorkItem(...args) as unknown,
  startAnalysisRun: (...args: unknown[]): unknown => startAnalysisRun(...args) as unknown,
  finishAnalysisRun: (...args: unknown[]): unknown => finishAnalysisRun(...args) as unknown,
  computeRetryBackoffMs: (attemptCount: number): number => attemptCount * 1000,
}))

/**
 * @param overrides - AnalysisWorkItem へ上書きするフィールド
 * @returns テスト用の AnalysisWorkItem
 */
function makeWorkItem(overrides: Partial<AnalysisWorkItem>): AnalysisWorkItem {
  return {
    id: 'work-item-1',
    kind: 'label_aggregate_refresh',
    triggerType: 'crawl_run',
    triggerId: 'crawl-1',
    status: 'leased',
    priority: 0,
    availableAt: new Date(),
    leaseOwner: 'worker-1',
    leaseExpiresAt: new Date(),
    attemptCount: 1,
    maxAttempts: 5,
    dependencyKey: null,
    lastErrorCode: null,
    lastErrorSummary: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

function makeDeps() {
  return {
    leaseOwner: 'worker-1',
    processReadModelRefresh: vi.fn().mockResolvedValue(undefined),
    processLabelAggregateRefresh: vi.fn().mockResolvedValue(undefined),
    processWeeklyReviewIngest: vi.fn().mockResolvedValue(undefined),
    processBlockReconciliation: vi.fn().mockResolvedValue(undefined),
    processRetentionSweep: vi.fn().mockResolvedValue(undefined),
    processPostCompletionRefresh: vi.fn().mockResolvedValue(undefined),
    processAccountSummaryRefresh: vi.fn().mockResolvedValue(undefined),
    processAccountFindingRefresh: vi.fn().mockResolvedValue(undefined),
    processAccountSummaryBootstrap: vi.fn().mockResolvedValue(undefined),
    onWorkItemSettled: vi.fn().mockResolvedValue(undefined),
  }
}

const prisma = {} as PrismaClient

describe('runWorkerLoopOnce', () => {
  beforeEach(() => {
    claimNextWorkItem.mockReset()
    completeWorkItem.mockReset().mockResolvedValue(true)
    enqueueWorkItem.mockReset().mockResolvedValue(undefined)
    startAnalysisRun.mockReset().mockResolvedValue('analysis-run-1')
    finishAnalysisRun.mockReset().mockResolvedValue(undefined)
    loggerWarn.mockReset()
    loggerError.mockReset()
  })

  it('queue が空なら false を返し、どの処理関数も呼ばない', async () => {
    claimNextWorkItem.mockResolvedValue(undefined)
    const deps = makeDeps()

    const result = await runWorkerLoopOnce(prisma, deps)

    expect(result).toBe(false)
    expect(deps.processLabelAggregateRefresh).not.toHaveBeenCalled()
  })

  it.each([
    ['label_aggregate_refresh', 'processLabelAggregateRefresh'],
    ['read_model_refresh', 'processReadModelRefresh'],
    ['weekly_review_ingest', 'processWeeklyReviewIngest'],
    ['block_reconciliation', 'processBlockReconciliation'],
    ['retention_sweep', 'processRetentionSweep'],
    ['account_summary_bootstrap', 'processAccountSummaryBootstrap'],
    [POST_COMPLETION_REFRESH_KIND, 'processPostCompletionRefresh'],
  ] as const)('kind が %s なら %s だけを呼ぶ', async (kind, depKey) => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({ kind }))
    const deps = makeDeps()

    await runWorkerLoopOnce(prisma, deps)

    expect(deps[depKey]).toHaveBeenCalledTimes(1)
    expect(completeWorkItem).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ workItemId: 'work-item-1', status: 'succeeded' }),
    )
  })

  it('処理が例外を投げ、attemptCount が maxAttempts 未満なら failed で記録する', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({ attemptCount: 1, maxAttempts: 5 }))
    const deps = makeDeps()
    deps.processLabelAggregateRefresh.mockRejectedValue(new Error('boom'))

    await runWorkerLoopOnce(prisma, deps)

    expect(completeWorkItem).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ status: 'failed', errorSummary: expect.stringContaining('boom') }),
    )
  })

  it('処理が例外を投げ、attemptCount が maxAttempts 以上なら dead で記録する', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({ attemptCount: 5, maxAttempts: 5 }))
    const deps = makeDeps()
    deps.processLabelAggregateRefresh.mockRejectedValue(new Error('boom'))

    await runWorkerLoopOnce(prisma, deps)

    expect(completeWorkItem).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ status: 'dead' }),
    )
  })

  it('処理が例外を投げたとき Error オブジェクトごとログへ出す', async () => {
    const error = new Error('boom')
    claimNextWorkItem.mockResolvedValue(makeWorkItem({}))
    const deps = makeDeps()
    deps.processLabelAggregateRefresh.mockRejectedValue(error)

    await runWorkerLoopOnce(prisma, deps)

    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('work-item-1'), error)
  })

  it('lease を失って完了を記録できなかった場合に警告を出す', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({}))
    completeWorkItem.mockResolvedValue(false)
    const deps = makeDeps()

    await runWorkerLoopOnce(prisma, deps)

    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('lease lost'))
  })

  it('attempt ごとに AnalysisRun を開始・終了として記録する', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({ attemptCount: 3 }))
    const deps = makeDeps()

    await runWorkerLoopOnce(prisma, deps)

    expect(startAnalysisRun).toHaveBeenCalledWith(prisma, {
      workItemId: 'work-item-1',
      attemptNumber: 3,
    })
    expect(finishAnalysisRun).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ analysisRunId: 'analysis-run-1', status: 'succeeded' }),
    )
  })

  it('失敗した attempt も AnalysisRun へ failed として記録する', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({ attemptCount: 1, maxAttempts: 5 }))
    const deps = makeDeps()
    deps.processLabelAggregateRefresh.mockRejectedValue(new Error('boom'))

    await runWorkerLoopOnce(prisma, deps)

    expect(finishAnalysisRun).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ status: 'failed', errorSummary: expect.stringContaining('boom') }),
    )
  })

  it('再試行の待機時刻を completeWorkItem へ渡す', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({ attemptCount: 2, maxAttempts: 5 }))
    const deps = makeDeps()
    deps.processLabelAggregateRefresh.mockRejectedValue(new Error('boom'))

    await runWorkerLoopOnce(prisma, deps)

    expect(completeWorkItem).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ retryAvailableAt: expect.any(Date) }),
    )
  })

  it('終了状態を確定させた後に onWorkItemSettled を呼ぶ', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({}))
    const deps = makeDeps()

    await runWorkerLoopOnce(prisma, deps)

    expect(deps.onWorkItemSettled).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ id: 'work-item-1' }),
      { status: 'succeeded', errorSummary: undefined },
    )
  })

  it('lease を失った場合は onWorkItemSettled を呼ばない', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({}))
    completeWorkItem.mockResolvedValue(false)
    const deps = makeDeps()

    await runWorkerLoopOnce(prisma, deps)

    expect(deps.onWorkItemSettled).not.toHaveBeenCalled()
  })

  it('onWorkItemSettled が例外を投げても loop は継続する', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({}))
    const deps = makeDeps()
    deps.onWorkItemSettled.mockRejectedValue(new Error('hook failed'))

    const result = await runWorkerLoopOnce(prisma, deps)

    expect(result).toBe(true)
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('post-completion hook failed'),
      expect.any(Error),
    )
  })

  it('onWorkItemSettled が例外を投げたら post_completion_refresh を durable な WorkItem として積む', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({ id: 'work-item-1' }))
    const deps = makeDeps()
    deps.onWorkItemSettled.mockRejectedValue(new Error('hook failed'))

    await runWorkerLoopOnce(prisma, deps)

    expect(enqueueWorkItem).toHaveBeenCalledWith(prisma, {
      kind: POST_COMPLETION_REFRESH_KIND,
      triggerType: WORK_ITEM_COMPLETION_TRIGGER_TYPE,
      triggerId: 'work-item-1',
    })
  })

  it('onWorkItemSettled が成功すれば post_completion_refresh を積まない', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({}))
    const deps = makeDeps()

    await runWorkerLoopOnce(prisma, deps)

    expect(enqueueWorkItem).not.toHaveBeenCalled()
  })

  it('kind が account_summary_refresh のとき、triggerType が account_classification_observation なら processAccountSummaryRefresh だけを呼ぶ', async () => {
    claimNextWorkItem.mockResolvedValue(
      makeWorkItem({
        kind: 'account_summary_refresh',
        triggerType: 'account_classification_observation',
      }),
    )
    const deps = makeDeps()

    await runWorkerLoopOnce(prisma, deps)

    expect(deps.processAccountSummaryRefresh).toHaveBeenCalledTimes(1)
    expect(deps.processAccountFindingRefresh).not.toHaveBeenCalled()
  })

  it('kind が account_summary_refresh のとき、triggerType が review_finding_occurrence なら processAccountFindingRefresh だけを呼ぶ', async () => {
    claimNextWorkItem.mockResolvedValue(
      makeWorkItem({
        kind: 'account_summary_refresh',
        triggerType: 'review_finding_occurrence',
      }),
    )
    const deps = makeDeps()

    await runWorkerLoopOnce(prisma, deps)

    expect(deps.processAccountFindingRefresh).toHaveBeenCalledTimes(1)
    expect(deps.processAccountSummaryRefresh).not.toHaveBeenCalled()
  })
})
