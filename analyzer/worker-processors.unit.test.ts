import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from './generated/prisma'
import { processAccountSummaryRefresh } from './worker-processors'

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
