import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getAllCrawlRuns, getCrawlRunDetail, getRecentCrawlRuns } from './crawl-runs'

function buildRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run1',
    startedAt: new Date('2026-07-28T00:00:00Z'),
    finishedAt: new Date('2026-07-28T01:00:00Z'),
    status: 'success',
    accountRuns: [
      {
        id: 'acc1',
        crawlRunId: 'run1',
        username: 'someuser',
        startedAt: new Date('2026-07-28T00:00:00Z'),
        finishedAt: new Date('2026-07-28T00:30:00Z'),
        status: 'success',
        recommendedCount: 10,
        followingCount: 5,
        trendingCount: 2,
        replyCount: 8,
        profileCount: 4,
        labelsAppliedCount: 3,
        followingSynced: true,
        followersSynced: true,
        warnings: [],
        errorMessage: null,
      },
    ],
    ...overrides,
  }
}

describe('getRecentCrawlRuns', () => {
  it('loads recent runs, most recent first, with only their account count', async () => {
    const { accountRuns, ...runWithoutAccountRuns } = buildRun()
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { ...runWithoutAccountRuns, _count: { accountRuns: accountRuns.length } },
      ])
    const prisma = { crawlRun: { findMany } } as unknown as PrismaClient

    const result = await getRecentCrawlRuns(prisma, 5)

    expect(result).toEqual([{ ...runWithoutAccountRuns, accountRunCount: accountRuns.length }])
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { startedAt: 'desc' },
      take: 5,
      include: { _count: { select: { accountRuns: true } } },
    })
  })
})

describe('getAllCrawlRuns', () => {
  it('loads every run, most recent first, with only its account count', async () => {
    const { accountRuns, ...runWithoutAccountRuns } = buildRun()
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { ...runWithoutAccountRuns, _count: { accountRuns: accountRuns.length } },
      ])
    const prisma = { crawlRun: { findMany } } as unknown as PrismaClient

    const result = await getAllCrawlRuns(prisma)

    expect(result).toEqual([{ ...runWithoutAccountRuns, accountRunCount: accountRuns.length }])
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { startedAt: 'desc' },
      include: { _count: { select: { accountRuns: true } } },
    })
  })
})

describe('getCrawlRunDetail', () => {
  it('loads a single run with its account runs by id', async () => {
    const findUnique = vi.fn().mockResolvedValue(buildRun())
    const prisma = { crawlRun: { findUnique } } as unknown as PrismaClient

    const result = await getCrawlRunDetail(prisma, 'run1')

    expect(result).toEqual(buildRun())
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'run1' },
      include: { accountRuns: { orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] } },
    })
  })

  it('returns null when no run has that id', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { crawlRun: { findUnique } } as unknown as PrismaClient

    const result = await getCrawlRunDetail(prisma, 'missing')

    expect(result).toBeNull()
  })
})
