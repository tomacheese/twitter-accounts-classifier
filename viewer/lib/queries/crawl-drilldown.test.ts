import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getCrawlAccountRuns } from './crawl-drilldown'

function createMockPrisma(overrides: { accountRuns?: unknown[]; checkpoints?: unknown[] }) {
  const accountRunFindMany = vi.fn().mockResolvedValue(overrides.accountRuns ?? [])
  const checkpointFindMany = vi.fn().mockResolvedValue(overrides.checkpoints ?? [])
  return {
    prisma: {
      crawlAccountRun: { findMany: accountRunFindMany },
      crawlAccountCheckpoint: { findMany: checkpointFindMany },
    } as unknown as PrismaClient,
    accountRunFindMany,
    checkpointFindMany,
  }
}

describe('getCrawlAccountRuns', () => {
  it('CrawlAccountRun と phase 別 duration を結合して返す', async () => {
    const { prisma } = createMockPrisma({
      accountRuns: [
        {
          id: 'run-1',
          username: 'alice',
          recommendedCount: 10,
          followingCount: 3,
          trendingCount: 0,
          replyCount: 2,
          profileCount: 1,
          labelsAppliedCount: 4,
          followingSynced: true,
          followersSynced: true,
          blocksSynced: false,
          warnings: [{ type: 'rate_limited' }, { type: 'rate_limited' }, { type: 'timeout' }],
          startedAt: new Date('2026-08-08T00:00:00Z'),
          finishedAt: new Date('2026-08-08T00:05:00Z'),
          status: 'success',
        },
      ],
      checkpoints: [
        { username: 'alice', phase: 'following', data: { durationMs: 1200, retryWaitMs: 100 } },
      ],
    })

    const result = await getCrawlAccountRuns(prisma, 'crawl-run-1')

    expect(result[0].warningCounts).toEqual({ rate_limited: 2, timeout: 1 })
    expect(result[0].phaseDurations).toEqual([
      { phase: 'following', durationMs: 1200, retryWaitMs: 100 },
    ])
  })

  it('warnings が空配列、checkpoint が無い account では空の集計を返す', async () => {
    const { prisma } = createMockPrisma({
      accountRuns: [
        {
          id: 'run-2',
          username: 'bob',
          recommendedCount: 0,
          followingCount: 0,
          trendingCount: 0,
          replyCount: 0,
          profileCount: 0,
          labelsAppliedCount: 0,
          followingSynced: false,
          followersSynced: false,
          blocksSynced: false,
          warnings: [],
          startedAt: new Date('2026-08-08T00:00:00Z'),
          finishedAt: null,
          status: 'running',
        },
      ],
      checkpoints: [],
    })

    const result = await getCrawlAccountRuns(prisma, 'crawl-run-1')

    expect(result[0].warningCounts).toEqual({})
    expect(result[0].phaseDurations).toEqual([])
  })
})
