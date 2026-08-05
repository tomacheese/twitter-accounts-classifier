import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getLatestBlockSummary } from './latest-block-summary'

function createMockPrisma(overrides: {
  latestRun?: unknown
  accountRuns?: unknown[]
  lastSuccessfulRun?: unknown
}) {
  const findFirst = vi
    .fn()
    .mockResolvedValueOnce(overrides.latestRun ?? null)
    .mockResolvedValueOnce(overrides.lastSuccessfulRun ?? null)
  const queryRaw = vi.fn().mockResolvedValue(overrides.accountRuns ?? [])
  return {
    blockRun: { findFirst },
    $queryRaw: queryRaw,
  } as unknown as PrismaClient
}

describe('getLatestBlockSummary', () => {
  it('returns null when no BlockRun exists', async () => {
    const prisma = createMockPrisma({})

    expect(await getLatestBlockSummary(prisma)).toBeNull()
  })

  it('summarizes the latest BlockRun with candidates, failure counts, and last success', async () => {
    const prisma = createMockPrisma({
      latestRun: {
        id: 'run-1',
        startedAt: new Date('2026-08-04T00:00:00Z'),
        finishedAt: new Date('2026-08-04T00:30:00Z'),
        status: 'completed',
      },
      accountRuns: [
        { candidatesCount: 5, blockedCount: 3, failedCount: 0 },
        { candidatesCount: 4, blockedCount: 2, failedCount: 1 },
      ],
      lastSuccessfulRun: {
        id: 'run-1',
        finishedAt: new Date('2026-08-04T00:30:00Z'),
      },
    })

    const summary = await getLatestBlockSummary(prisma)

    expect(summary).toEqual({
      blockRunId: 'run-1',
      startedAt: new Date('2026-08-04T00:00:00Z'),
      finishedAt: new Date('2026-08-04T00:30:00Z'),
      status: 'completed',
      accountRunCount: 2,
      candidatesCount: 9,
      blockedCount: 5,
      failureCount: 1,
      lastSuccessAt: new Date('2026-08-04T00:30:00Z'),
    })
  })

  it('counts each username only once, using its latest attempt, when a run was retried', async () => {
    const prisma = createMockPrisma({
      latestRun: {
        id: 'run-1',
        startedAt: new Date('2026-08-04T00:00:00Z'),
        finishedAt: new Date('2026-08-04T00:30:00Z'),
        status: 'completed',
      },
      // DISTINCT ON ("username") が SQL 側で担う絞り込みなので、
      // ここでは alice の最新試行1件分だけが返るモックにしている。
      accountRuns: [{ candidatesCount: 2, blockedCount: 1, failedCount: 0 }],
    })

    const summary = await getLatestBlockSummary(prisma)

    expect(summary?.accountRunCount).toBe(1)
    expect(summary?.candidatesCount).toBe(2)
    expect(summary?.blockedCount).toBe(1)
    expect(summary?.failureCount).toBe(0)
  })

  it('returns null lastSuccessAt when no BlockRun has ever completed', async () => {
    const prisma = createMockPrisma({
      latestRun: {
        id: 'run-1',
        startedAt: new Date('2026-08-04T00:00:00Z'),
        finishedAt: new Date('2026-08-04T00:30:00Z'),
        status: 'failed',
      },
      accountRuns: [],
    })

    const summary = await getLatestBlockSummary(prisma)

    expect(summary?.lastSuccessAt).toBeNull()
  })
})
