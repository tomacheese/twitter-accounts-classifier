import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getLatestCrawlSummary } from './latest-crawl-summary'

describe('getLatestCrawlSummary', () => {
  it('returns null when no CrawlRun exists', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const prisma = { crawlRun: { findFirst } } as unknown as PrismaClient

    expect(await getLatestCrawlSummary(prisma)).toBeNull()
  })

  it('counts each username only once, using its latest attempt, and aggregates per-source metrics', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run1',
      startedAt: new Date('2026-08-04T00:00:00Z'),
      finishedAt: new Date('2026-08-04T01:00:00Z'),
      status: 'success',
    })
    const queryRaw = vi.fn().mockResolvedValue([
      {
        username: 'alice',
        status: 'success',
        startedAt: new Date('2026-08-04T00:00:00Z'),
        finishedAt: new Date('2026-08-04T00:10:00Z'),
        recommendedCount: 10,
        followingCount: 5,
        trendingCount: 2,
        replyCount: 1,
        profileCount: 1,
        labelsAppliedCount: 3,
        warnings: ['example warning'],
        appVersion: '1.2.0',
      },
      {
        username: 'bob',
        status: 'partial',
        startedAt: new Date('2026-08-04T00:10:00Z'),
        finishedAt: new Date('2026-08-04T00:25:00Z'),
        recommendedCount: 4,
        followingCount: 3,
        trendingCount: 0,
        replyCount: 0,
        profileCount: 1,
        labelsAppliedCount: 1,
        warnings: [],
        appVersion: '1.3.0',
      },
    ])
    const prisma = {
      crawlRun: { findFirst },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient

    const summary = await getLatestCrawlSummary(prisma)

    expect(summary).toEqual({
      crawlRunId: 'run1',
      startedAt: new Date('2026-08-04T00:00:00Z'),
      finishedAt: new Date('2026-08-04T01:00:00Z'),
      status: 'success',
      accountCount: 2,
      successCount: 1,
      partialOrFailedCount: 1,
      recommendedCount: 14,
      followingCount: 8,
      trendingCount: 2,
      replyCount: 1,
      profileCount: 2,
      labelsAppliedCount: 4,
      warningCount: 1,
      totalDurationMs: 10 * 60_000 + 15 * 60_000,
      appVersions: ['1.2.0', '1.3.0'],
    })
  })
})
