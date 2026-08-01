import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import {
  finishCrawlRun,
  recordCrawlAccountRun,
  startOrResumeCrawlRun,
} from './crawl-run-repository'

describe('startOrResumeCrawlRun', () => {
  it('creates a CrawlRun row when no interrupted run exists', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const create = vi.fn().mockResolvedValue({ id: 'run1' })
    const prisma = { crawlRun: { findFirst, create } } as unknown as PrismaClient
    const startedAt = new Date('2026-07-28T00:00:00Z')

    const result = await startOrResumeCrawlRun(prisma, startedAt)

    expect(result).toEqual({ id: 'run1', latestAccountStatuses: new Map() })
    expect(findFirst).toHaveBeenCalledWith({
      where: { status: 'running' },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    })
    expect(create).toHaveBeenCalledWith({
      data: { startedAt, status: 'running' },
    })
  })

  it('reuses the newest interrupted run and keeps only each account’s latest status', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run2',
    })
    const queryRaw = vi.fn().mockResolvedValue([
      { username: 'alice', status: 'failed' },
      { username: 'bob', status: 'partial' },
    ])
    const create = vi.fn()
    const prisma = {
      crawlRun: { findFirst, create },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient

    const result = await startOrResumeCrawlRun(prisma, new Date('2026-07-28T00:00:00Z'))

    expect(result).toEqual({
      id: 'run2',
      latestAccountStatuses: new Map([
        ['alice', 'failed'],
        ['bob', 'partial'],
      ]),
    })
    const [query, crawlRunId] = queryRaw.mock.calls[0]
    expect(query.join('')).toContain('SELECT DISTINCT ON ("username") "username", "status"')
    expect(query.join('')).toContain('WHERE "crawlRunId" = ')
    expect(query.join('')).toContain('ORDER BY "username", "startedAt" DESC, "id" DESC')
    expect(crawlRunId).toBe('run2')
    expect(create).not.toHaveBeenCalled()
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
