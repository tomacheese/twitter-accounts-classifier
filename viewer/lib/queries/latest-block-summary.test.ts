import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getLatestBlockSummary } from './latest-block-summary'

describe('getLatestBlockSummary', () => {
  it('returns null when no BlockRun exists', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const prisma = { blockRun: { findFirst } } as unknown as PrismaClient

    expect(await getLatestBlockSummary(prisma)).toBeNull()
  })

  it('summarizes the latest BlockRun with account run and failure counts', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-1',
      startedAt: new Date('2026-08-04T00:00:00Z'),
      finishedAt: new Date('2026-08-04T00:30:00Z'),
      status: 'completed',
      _count: { accountRuns: 3 },
    })
    const aggregate = vi.fn().mockResolvedValue({ _sum: { blockedCount: 5, failedCount: 1 } })
    const prisma = {
      blockRun: { findFirst },
      blockAccountRun: { aggregate },
    } as unknown as PrismaClient

    const summary = await getLatestBlockSummary(prisma)

    expect(summary).toEqual({
      blockRunId: 'run-1',
      startedAt: new Date('2026-08-04T00:00:00Z'),
      finishedAt: new Date('2026-08-04T00:30:00Z'),
      status: 'completed',
      accountRunCount: 3,
      blockedCount: 5,
      failureCount: 1,
    })
  })
})
