import { describe, expect, it, vi } from 'vitest'

const connect = vi.fn().mockResolvedValue(undefined)
const runWorkerLoopOnce = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)

vi.mock('./db/client', () => ({
  getPrismaClient: () => ({ $connect: connect }),
  disconnectPrisma: vi.fn().mockResolvedValue(undefined),
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
}))

describe('main', () => {
  it('例外を投げずに $connect を呼び、queue が空になるまで claim して終了する', async () => {
    const { main } = await import('./index')

    await expect(main()).resolves.toBeUndefined()
    expect(connect).toHaveBeenCalledTimes(1)
    expect(runWorkerLoopOnce).toHaveBeenCalled()
  })
})
