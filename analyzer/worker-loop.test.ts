import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AnalysisWorkItem, PrismaClient } from './generated/prisma'
import { runWorkerLoopOnce } from './worker-loop'

const claimNextWorkItem = vi.fn()
const completeWorkItem = vi.fn()

vi.mock('./queue/work-item-repository', () => ({
  claimNextWorkItem: (...args: unknown[]): unknown => claimNextWorkItem(...args) as unknown,
  completeWorkItem: (...args: unknown[]): unknown => completeWorkItem(...args) as unknown,
}))

/**
 * @param overrides - AnalysisWorkItem へ上書きするフィールド
 * @returns テスト用の AnalysisWorkItem
 */
function makeWorkItem(overrides: Partial<AnalysisWorkItem>): AnalysisWorkItem {
  return {
    id: 'work-item-1',
    kind: 'label_metrics',
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
    processLabelMetrics: vi.fn().mockResolvedValue(undefined),
    processFindingGeneration: vi.fn().mockResolvedValue(undefined),
    processReadModelRefresh: vi.fn().mockResolvedValue(undefined),
    processWeeklyReviewIngest: vi.fn().mockResolvedValue(undefined),
    processBlockReconciliation: vi.fn().mockResolvedValue(undefined),
  }
}

const prisma = {} as PrismaClient

describe('runWorkerLoopOnce', () => {
  beforeEach(() => {
    claimNextWorkItem.mockReset()
    completeWorkItem.mockReset().mockResolvedValue(true)
  })

  it('queue が空なら false を返し、どの処理関数も呼ばない', async () => {
    claimNextWorkItem.mockResolvedValue(undefined)
    const deps = makeDeps()

    const result = await runWorkerLoopOnce(prisma, deps)

    expect(result).toBe(false)
    expect(deps.processLabelMetrics).not.toHaveBeenCalled()
  })

  it.each([
    ['label_metrics', 'processLabelMetrics'],
    ['finding_generation', 'processFindingGeneration'],
    ['read_model_refresh', 'processReadModelRefresh'],
    ['weekly_review_ingest', 'processWeeklyReviewIngest'],
    ['block_reconciliation', 'processBlockReconciliation'],
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
    deps.processLabelMetrics.mockRejectedValue(new Error('boom'))

    await runWorkerLoopOnce(prisma, deps)

    expect(completeWorkItem).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ status: 'failed', errorSummary: expect.stringContaining('boom') }),
    )
  })

  it('処理が例外を投げ、attemptCount が maxAttempts 以上なら dead で記録する', async () => {
    claimNextWorkItem.mockResolvedValue(makeWorkItem({ attemptCount: 5, maxAttempts: 5 }))
    const deps = makeDeps()
    deps.processLabelMetrics.mockRejectedValue(new Error('boom'))

    await runWorkerLoopOnce(prisma, deps)

    expect(completeWorkItem).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ status: 'dead' }),
    )
  })
})
