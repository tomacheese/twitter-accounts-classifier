import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { finishCrawlRun, recordCrawlAccountRun, startCrawlRun } from './crawl-run-repository'

describe('startCrawlRun', () => {
  it('creates a CrawlRun row with the given startedAt and a placeholder status', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'run1' })
    const prisma = { crawlRun: { create } } as unknown as PrismaClient
    const startedAt = new Date('2026-07-28T00:00:00Z')

    const result = await startCrawlRun(prisma, startedAt)

    expect(result).toEqual({ id: 'run1' })
    expect(create).toHaveBeenCalledWith({
      data: { startedAt, status: 'running' },
    })
  })
})

describe('finishCrawlRun', () => {
  it('updates finishedAt and status for the given run id', async () => {
    const update = vi.fn().mockResolvedValue({})
    const prisma = { crawlRun: { update } } as unknown as PrismaClient
    const finishedAt = new Date('2026-07-28T01:00:00Z')

    await finishCrawlRun(prisma, 'run1', finishedAt, 'partial')

    expect(update).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: { finishedAt, status: 'partial' },
    })
  })
})

describe('recordCrawlAccountRun', () => {
  it('creates a CrawlAccountRun row with every provided field', async () => {
    const create = vi.fn().mockResolvedValue({})
    const prisma = { crawlAccountRun: { create } } as unknown as PrismaClient
    const startedAt = new Date('2026-07-28T00:00:00Z')
    const finishedAt = new Date('2026-07-28T00:05:00Z')

    await recordCrawlAccountRun(prisma, {
      crawlRunId: 'run1',
      username: 'someuser',
      startedAt,
      finishedAt,
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
    })

    expect(create).toHaveBeenCalledWith({
      data: {
        crawlRunId: 'run1',
        username: 'someuser',
        startedAt,
        finishedAt,
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
    })
  })
})
