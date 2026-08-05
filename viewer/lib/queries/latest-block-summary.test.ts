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
    })
    const queryRaw = vi.fn().mockResolvedValue([
      { blockedCount: 3, failedCount: 0 },
      { blockedCount: 2, failedCount: 1 },
    ])
    const prisma = {
      blockRun: { findFirst },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient

    const summary = await getLatestBlockSummary(prisma)

    expect(summary).toEqual({
      blockRunId: 'run-1',
      startedAt: new Date('2026-08-04T00:00:00Z'),
      finishedAt: new Date('2026-08-04T00:30:00Z'),
      status: 'completed',
      accountRunCount: 2,
      blockedCount: 5,
      failureCount: 1,
    })
  })

  it('counts each username only once, using its latest attempt, when a run was retried', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run-1',
      startedAt: new Date('2026-08-04T00:00:00Z'),
      finishedAt: new Date('2026-08-04T00:30:00Z'),
      status: 'completed',
    })
    // DISTINCT ON ("username") が SQL 側で担う絞り込みなので、
    // ここでは alice の最新試行1件分だけが返るモックにしている。
    const queryRaw = vi.fn().mockResolvedValue([{ blockedCount: 1, failedCount: 0 }])
    const prisma = {
      blockRun: { findFirst },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient

    const summary = await getLatestBlockSummary(prisma)

    expect(summary?.accountRunCount).toBe(1)
    expect(summary?.blockedCount).toBe(1)
    expect(summary?.failureCount).toBe(0)
  })
})
