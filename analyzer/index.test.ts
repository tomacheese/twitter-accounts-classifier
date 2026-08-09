import { describe, expect, it, vi } from 'vitest'

const connect = vi.fn().mockResolvedValue(undefined)
const leaseConnect = vi.fn().mockResolvedValue(undefined)
const mainPrisma = { $connect: connect }
const leasePrisma = { $connect: leaseConnect }
const runWorkerLoopOnce = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
const recordPolicyVersion = vi.fn().mockResolvedValue('hash')

vi.mock('./db/client', () => ({
  getPrismaClient: () => mainPrisma,
  getLeasePrismaClient: () => leasePrisma,
  disconnectPrisma: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./policy/load-policy', () => ({
  DEFAULT_POLICY_PATH: '/policy.json',
  loadPolicy: vi.fn().mockReturnValue({ schemaVersion: 1, policyVersion: 'v1', rules: [] }),
  recordPolicyVersion: (...args: unknown[]): unknown => recordPolicyVersion(...args),
}))

vi.mock('./worker-loop', () => ({
  runWorkerLoopOnce: (...args: unknown[]): unknown => runWorkerLoopOnce(...args),
}))

vi.mock('./worker-processors', () => ({
  processLabelMetrics: vi.fn(),
  processFindingGeneration: vi.fn(),
  processReadModelRefresh: vi.fn(),
  processWeeklyReviewIngest: vi.fn(),
  processBlockReconciliation: vi.fn(),
  processRetentionSweep: vi.fn(),
  processPostCompletionRefresh: vi.fn(),
  enqueueDailyRetentionSweep: vi.fn().mockResolvedValue(undefined),
  enqueueReadModelBootstrapIfMissing: vi.fn().mockResolvedValue(undefined),
  refreshReadModelFreshnessFromPolicy: vi.fn().mockResolvedValue(undefined),
  handleWorkItemSettled: vi.fn(),
}))

describe('main', () => {
  it('例外を投げずに $connect を呼び、queue が空になるまで claim して終了する', async () => {
    const { main } = await import('./index')

    await expect(main()).resolves.toBeUndefined()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(leaseConnect).toHaveBeenCalledTimes(1)
    expect(runWorkerLoopOnce).toHaveBeenCalledWith(
      mainPrisma,
      expect.objectContaining({ leasePrisma }),
    )
  })

  it('起動時に適用中 policy を記録する', async () => {
    const { main } = await import('./index')

    await main()

    expect(recordPolicyVersion).toHaveBeenCalled()
  })
})
