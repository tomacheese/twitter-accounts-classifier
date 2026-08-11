import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getCrawlAccountRuns } from './crawl-drilldown'

interface MockAccountRun {
  id: string
  username: string
  recommendedCount: number
  followingCount: number
  trendingCount: number
  replyCount: number
  profileCount: number
  labelsAppliedCount: number
  followingSynced: boolean
  followersSynced: boolean
  blocksSynced: boolean
  warnings: unknown
  startedAt: Date
  finishedAt: Date | null
  status: string
  classificationStatus?: string
}

function createMockPrisma(overrides: { accountRuns?: MockAccountRun[]; checkpoints?: unknown[] }) {
  const allAccountRuns = overrides.accountRuns ?? []
  const accountRunFindMany = vi
    .fn()
    .mockImplementation((args: { where?: { classificationStatus?: { not?: string } } }) => {
      const excludedStatus = args.where?.classificationStatus?.not
      const filtered =
        excludedStatus === undefined
          ? allAccountRuns
          : allAccountRuns.filter((run) => run.classificationStatus !== excludedStatus)
      return Promise.resolve(filtered)
    })
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

describe('getCrawlAccountRuns の skipped 除外', () => {
  it('success 行 + resume の skipped 行が同一 username にある場合、success 行のみを返す', async () => {
    const { prisma, accountRunFindMany } = createMockPrisma({
      accountRuns: [
        {
          id: 'run-success',
          username: 'alice',
          recommendedCount: 100,
          followingCount: 3,
          trendingCount: 0,
          replyCount: 2,
          profileCount: 1,
          labelsAppliedCount: 4,
          followingSynced: true,
          followersSynced: true,
          blocksSynced: false,
          warnings: [],
          startedAt: new Date('2026-08-08T00:00:00Z'),
          finishedAt: new Date('2026-08-08T00:05:00Z'),
          status: 'success',
          classificationStatus: 'success',
        },
        {
          id: 'run-skipped',
          username: 'alice',
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
          startedAt: new Date('2026-08-09T00:00:00Z'),
          finishedAt: new Date('2026-08-09T00:00:01Z'),
          status: 'success',
          classificationStatus: 'skipped',
        },
      ],
      checkpoints: [
        { username: 'alice', phase: 'following', data: { durationMs: 1200, retryWaitMs: null } },
      ],
    })

    const result = await getCrawlAccountRuns(prisma, 'crawl-run-1')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('run-success')
    expect(result[0].recommendedCount).toBe(100)
    expect(result[0].phaseDurations).toEqual([
      { phase: 'following', durationMs: 1200, retryWaitMs: null },
    ])
    expect(accountRunFindMany).toHaveBeenCalledWith({
      where: { crawlRunId: 'crawl-run-1', classificationStatus: { not: 'skipped' } },
      orderBy: [{ startedAt: 'asc' }],
    })
  })

  it('partial 行 + resume の skipped 行がある場合、partial 行のみを返す', async () => {
    const { prisma } = createMockPrisma({
      accountRuns: [
        {
          id: 'run-partial',
          username: 'bob',
          recommendedCount: 5,
          followingCount: 1,
          trendingCount: 0,
          replyCount: 0,
          profileCount: 0,
          labelsAppliedCount: 1,
          followingSynced: false,
          followersSynced: false,
          blocksSynced: false,
          warnings: [{ type: 'timeout' }],
          startedAt: new Date('2026-08-08T00:00:00Z'),
          finishedAt: new Date('2026-08-08T00:03:00Z'),
          status: 'partial',
          classificationStatus: 'partial',
        },
        {
          id: 'run-skipped',
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
          startedAt: new Date('2026-08-09T00:00:00Z'),
          finishedAt: new Date('2026-08-09T00:00:01Z'),
          status: 'success',
          classificationStatus: 'skipped',
        },
      ],
      checkpoints: [],
    })

    const result = await getCrawlAccountRuns(prisma, 'crawl-run-1')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('run-partial')
    expect(result[0].status).toBe('partial')
    expect(result[0].warningCounts).toEqual({ timeout: 1 })
  })

  it('classificationStatus が unknown の legacy 行は除外しない', async () => {
    const { prisma } = createMockPrisma({
      accountRuns: [
        {
          id: 'run-legacy',
          username: 'carol',
          recommendedCount: 7,
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
          finishedAt: new Date('2026-08-08T00:02:00Z'),
          status: 'success',
          classificationStatus: 'unknown',
        },
      ],
      checkpoints: [],
    })

    const result = await getCrawlAccountRuns(prisma, 'crawl-run-1')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('run-legacy')
  })

  it('resume が発生していない通常 run では全行がそのまま返る', async () => {
    const { prisma } = createMockPrisma({
      accountRuns: [
        {
          id: 'run-only',
          username: 'dave',
          recommendedCount: 12,
          followingCount: 2,
          trendingCount: 1,
          replyCount: 0,
          profileCount: 0,
          labelsAppliedCount: 3,
          followingSynced: true,
          followersSynced: true,
          blocksSynced: true,
          warnings: [],
          startedAt: new Date('2026-08-08T00:00:00Z'),
          finishedAt: new Date('2026-08-08T00:04:00Z'),
          status: 'success',
          classificationStatus: 'success',
        },
      ],
      checkpoints: [],
    })

    const result = await getCrawlAccountRuns(prisma, 'crawl-run-1')

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('run-only')
  })
})
