import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import {
  clearCrawlAccountCheckpoints,
  completeCrawlAccountCheckpoint,
  finishCrawlRun,
  loadCrawlAccountCheckpoints,
  recordCrawlAccountRun,
  setCurrentAccount,
  startOrResumeCrawlRun,
  touchCrawlRunHeartbeat,
} from './crawl-run-repository'

describe('startOrResumeCrawlRun', () => {
  const staleThresholdMs = 3 * 21_600 * 1000

  it('creates a CrawlRun row when no interrupted run exists', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const create = vi.fn().mockResolvedValue({ id: 'run1' })
    const prisma = { crawlRun: { findFirst, create } } as unknown as PrismaClient
    const startedAt = new Date('2026-07-28T00:00:00Z')

    const result = await startOrResumeCrawlRun(prisma, startedAt, staleThresholdMs)

    expect(result).toEqual({ id: 'run1', latestAccountStatuses: new Map() })
    expect(findFirst).toHaveBeenCalledWith({
      where: { status: 'running' },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, lastHeartbeatAt: true },
    })
    expect(create).toHaveBeenCalledWith({
      data: {
        startedAt,
        lastHeartbeatAt: startedAt,
        status: 'running',
        staleAfterAt: new Date(startedAt.getTime() + staleThresholdMs),
      },
    })
  })

  it('reuses the newest interrupted run when its heartbeat is within the threshold', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run2',
      lastHeartbeatAt: new Date('2026-07-27T23:00:00Z'),
    })
    let sqlQuery: TemplateStringsArray | undefined
    let requestedRunId: string | undefined
    const queryRaw = vi.fn((query: TemplateStringsArray, crawlRunId: string) => {
      sqlQuery = query
      requestedRunId = crawlRunId
      return Promise.resolve([
        { username: 'alice', status: 'failed' },
        { username: 'bob', status: 'partial' },
      ])
    })
    const create = vi.fn()
    const update = vi.fn()
    const prisma = {
      crawlRun: { findFirst, create, update },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient

    const result = await startOrResumeCrawlRun(
      prisma,
      new Date('2026-07-28T00:00:00Z'),
      staleThresholdMs,
    )

    expect(result).toEqual({
      id: 'run2',
      latestAccountStatuses: new Map([
        ['alice', 'failed'],
        ['bob', 'partial'],
      ]),
    })
    if (!sqlQuery) throw new Error('Expected the latest account status query')
    expect(sqlQuery.join('')).toContain('SELECT DISTINCT ON ("username") "username", "status"')
    expect(sqlQuery.join('')).toContain('WHERE "crawlRunId" = ')
    expect(sqlQuery.join('')).toContain('ORDER BY "username", "startedAt" DESC, "id" DESC')
    expect(requestedRunId).toBe('run2')
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('abandons a running row whose heartbeat exceeds the stale threshold and starts a new run', async () => {
    const startedAt = new Date('2026-07-28T00:00:00Z')
    // lastHeartbeatAt は startedAt の 20 時間前とし、staleThresholdMs (18 時間) を超えさせる
    const lastHeartbeatAt = new Date(startedAt.getTime() - 20 * 60 * 60 * 1000)
    const findFirst = vi.fn().mockResolvedValue({
      id: 'abandoned-run',
      lastHeartbeatAt,
    })
    const create = vi.fn().mockResolvedValue({ id: 'new-run' })
    const update = vi.fn().mockResolvedValue({})
    const deleteCheckpoints = vi.fn().mockReturnValue({})
    const deleteLabelClaims = vi.fn().mockReturnValue({})
    const transaction = vi.fn().mockResolvedValue([])
    const prisma = {
      crawlRun: { findFirst, create, update },
      crawlAccountCheckpoint: { deleteMany: deleteCheckpoints },
      crawlAccountLabelRun: { deleteMany: deleteLabelClaims },
      $transaction: transaction,
    } as unknown as PrismaClient

    const result = await startOrResumeCrawlRun(prisma, startedAt, staleThresholdMs)

    expect(result).toEqual({ id: 'new-run', latestAccountStatuses: new Map() })
    expect(update).toHaveBeenCalledWith({
      where: { id: 'abandoned-run' },
      data: {
        finishedAt: lastHeartbeatAt,
        status: 'failed',
        currentUsername: null,
        currentAccountStartedAt: null,
      },
    })
    expect(deleteCheckpoints).toHaveBeenCalledWith({ where: { crawlRunId: 'abandoned-run' } })
    expect(deleteLabelClaims).toHaveBeenCalledWith({ where: { crawlRunId: 'abandoned-run' } })
    expect(create).toHaveBeenCalledWith({
      data: {
        startedAt,
        lastHeartbeatAt: startedAt,
        status: 'running',
        staleAfterAt: new Date(startedAt.getTime() + staleThresholdMs),
      },
    })
  })

  it('resumes a running row exactly at the stale threshold boundary (not stale)', async () => {
    const startedAt = new Date('2026-07-28T00:00:00Z')
    const lastHeartbeatAt = new Date(startedAt.getTime() - staleThresholdMs)
    const findFirst = vi.fn().mockResolvedValue({ id: 'run3', lastHeartbeatAt })
    const queryRaw = vi.fn().mockResolvedValue([])
    const create = vi.fn()
    const update = vi.fn()
    const prisma = {
      crawlRun: { findFirst, create, update },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient

    const result = await startOrResumeCrawlRun(prisma, startedAt, staleThresholdMs)

    expect(result.id).toBe('run3')
    expect(create).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})

describe('touchCrawlRunHeartbeat', () => {
  it('updates lastHeartbeatAt and staleAfterAt from the given time and threshold', async () => {
    const update = vi.fn().mockResolvedValue({})
    const prisma = { crawlRun: { update } } as unknown as PrismaClient
    const at = new Date('2026-08-05T00:00:00Z')

    await touchCrawlRunHeartbeat(prisma, 'run1', at, 3_600_000)

    expect(update).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: { lastHeartbeatAt: at, staleAfterAt: new Date('2026-08-05T01:00:00Z') },
    })
  })
})

describe('finishCrawlRun', () => {
  it('updates finishedAt, status, and clears the current-account fields', async () => {
    const update = vi.fn().mockResolvedValue({})
    const prisma = { crawlRun: { update } } as unknown as PrismaClient
    const finishedAt = new Date('2026-07-28T01:00:00Z')

    await finishCrawlRun(prisma, 'run1', finishedAt, 'partial')

    expect(update).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: {
        finishedAt,
        status: 'partial',
        currentUsername: null,
        currentAccountStartedAt: null,
      },
    })
  })
})

describe('setCurrentAccount', () => {
  it('updates the current-account fields for the given run id', async () => {
    const update = vi.fn().mockResolvedValue({})
    const prisma = { crawlRun: { update } } as unknown as PrismaClient
    const startedAt = new Date('2026-07-28T00:10:00Z')

    await setCurrentAccount(prisma, 'run1', 'alice', startedAt)

    expect(update).toHaveBeenCalledWith({
      where: { id: 'run1' },
      data: { currentUsername: 'alice', currentAccountStartedAt: startedAt },
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
      blocksSynced: true,
      warnings: [],
      errorMessage: null,
      appVersion: 'v1.2.3',
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
        blocksSynced: true,
        warnings: [],
        errorMessage: null,
        appVersion: 'v1.2.3',
      },
    })
  })
})

describe('crawl account checkpoints', () => {
  it('loads only recognized completed phases for an account', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { phase: 'timelines', data: { version: 1 } },
      { phase: 'unknown_future_phase', data: { ignored: true } },
      { phase: 'followers', data: { synced: true } },
    ])
    const prisma = {
      crawlAccountCheckpoint: { findMany },
    } as unknown as PrismaClient

    const result = await loadCrawlAccountCheckpoints(prisma, 'run1', 'someuser')

    expect(result).toEqual(
      new Map([
        ['timelines', { version: 1 }],
        ['followers', { synced: true }],
      ]),
    )
    expect(findMany).toHaveBeenCalledWith({
      where: { crawlRunId: 'run1', username: 'someuser' },
      select: { phase: true, data: true },
    })
  })

  it('upserts a phase checkpoint by crawl run, account, and phase', async () => {
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = {
      crawlAccountCheckpoint: { upsert },
    } as unknown as PrismaClient

    await completeCrawlAccountCheckpoint(prisma, {
      crawlRunId: 'run1',
      username: 'someuser',
      phase: 'following',
      data: { userId: 'account1', synced: true },
    })

    expect(upsert).toHaveBeenCalledWith({
      where: {
        crawlRunId_username_phase: {
          crawlRunId: 'run1',
          username: 'someuser',
          phase: 'following',
        },
      },
      create: {
        crawlRunId: 'run1',
        username: 'someuser',
        phase: 'following',
        data: { userId: 'account1', synced: true },
      },
      update: {
        data: { userId: 'account1', synced: true },
        completedAt: expect.any(Date),
      },
    })
  })

  it('clears transient resume state for a normally completed crawl run', async () => {
    const checkpointOperation = {} as ReturnType<
      PrismaClient['crawlAccountCheckpoint']['deleteMany']
    >
    const labelClaimOperation = {} as ReturnType<PrismaClient['crawlAccountLabelRun']['deleteMany']>
    const deleteCheckpoints = vi.fn().mockReturnValue(checkpointOperation)
    const deleteLabelClaims = vi.fn().mockReturnValue(labelClaimOperation)
    const transaction = vi.fn().mockResolvedValue([])
    const prisma = {
      crawlAccountCheckpoint: { deleteMany: deleteCheckpoints },
      crawlAccountLabelRun: { deleteMany: deleteLabelClaims },
      $transaction: transaction,
    } as unknown as PrismaClient

    await clearCrawlAccountCheckpoints(prisma, 'run1')

    expect(deleteCheckpoints).toHaveBeenCalledWith({ where: { crawlRunId: 'run1' } })
    expect(deleteLabelClaims).toHaveBeenCalledWith({ where: { crawlRunId: 'run1' } })
    expect(transaction).toHaveBeenCalledWith([checkpointOperation, labelClaimOperation])
  })
})
