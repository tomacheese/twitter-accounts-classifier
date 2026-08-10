import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import { enqueueReadModelBootstrapIfMissing, processAccountSummaryRefresh } from './worker-processors'

describe('enqueueReadModelBootstrapIfMissing', () => {
  it('account_summary pointer が無ければ最新 terminal crawl の label_metrics を再キューする', async () => {
    const upsert = vi.fn().mockResolvedValue(undefined)
    const prisma = {
      readModelPointer: { findUnique: vi.fn().mockResolvedValue(null) },
      crawlRun: {
        findFirst: vi.fn().mockResolvedValue({ id: 'crawl-1', status: 'partial' }),
      },
      analysisWorkItem: { upsert },
    } as unknown as PrismaClient

    await enqueueReadModelBootstrapIfMissing(prisma)

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind_triggerType_triggerId: {
            kind: 'label_metrics',
            triggerType: 'crawl_run',
            triggerId: 'crawl-1',
          },
        },
        update: expect.objectContaining({ status: 'queued', attemptCount: 0 }),
      }),
    )
  })

  it('account_summary pointer があれば何もしない', async () => {
    const findFirst = vi.fn()
    const upsert = vi.fn()
    const prisma = {
      readModelPointer: {
        findUnique: vi.fn().mockResolvedValue({ currentGenerationId: 'generation-1' }),
      },
      crawlRun: { findFirst },
      analysisWorkItem: { upsert },
    } as unknown as PrismaClient

    await enqueueReadModelBootstrapIfMissing(prisma)

    expect(findFirst).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
  })
})


describe('processAccountSummaryRefresh transaction budget', () => {
  it('passes an explicit 30 second timeout to the write transaction', async () => {
    const observedAt = new Date('2026-08-10T00:00:00Z')
    const tx = { $executeRaw: vi.fn().mockResolvedValue(1) }
    const transaction = vi.fn(async (callback: (tx: unknown) => Promise<void>) => callback(tx))
    const prisma = {
      accountClassificationObservation: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'observation-1',
          accountId: 'account-1',
          crawlRunId: 'crawl-1',
          observedAt,
        }),
      },
      account: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          id: 'account-1',
          screenName: 'Alice',
          displayName: 'Alice',
          lastCrawledAt: observedAt,
        }),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
      accountSummaryLatest: { findUnique: vi.fn().mockResolvedValue(null) },
      labelDefinition: { findMany: vi.fn().mockResolvedValue([]) },
      readModelState: { upsert: vi.fn().mockResolvedValue(undefined) },
      $transaction: transaction,
    } as unknown as PrismaClient

    await processAccountSummaryRefresh(prisma, {
      id: 'work-1',
      triggerId: 'observation-1',
    } as never)

    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 60_000 }),
    )
  })
})
