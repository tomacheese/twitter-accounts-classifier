import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import {
  clearCrawlAccountCheckpoints,
  completeCrawlAccountCheckpoint,
  CRAWL_ACCOUNT_CHECKPOINT_PHASES,
  finishCrawlRun,
  loadCrawlAccountCheckpoints,
  loadCrawlAuthorCheckpoints,
  recordCrawlAccountRun,
  recordCrawlAuthorCheckpoint,
  setCurrentAccount,
  startOrResumeCrawlRun,
  touchCrawlRunHeartbeat,
} from './crawl-run-repository'

describe('startOrResumeCrawlRun', () => {
  const staleThresholdMs = 3 * 21_600 * 1000

  it('creates a CrawlRun row when no interrupted run exists', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const startedAt = new Date('2026-07-28T00:00:00Z')
    const create = vi.fn().mockResolvedValue({ id: 'run1', startedAt })
    const upsert = vi.fn().mockResolvedValue({})
    const tx = { crawlRun: { create }, analysisWorkItem: { upsert } }
    const transaction = vi.fn((fn: (transactionClient: unknown) => Promise<unknown>) => fn(tx))
    const prisma = {
      crawlRun: { findFirst, create },
      $transaction: transaction,
    } as unknown as PrismaClient

    const result = await startOrResumeCrawlRun(prisma, startedAt, staleThresholdMs)

    expect(result).toEqual({ id: 'run1', latestAccountStatuses: new Map(), startedAt })
    expect(findFirst).toHaveBeenCalledWith({
      where: { status: 'running' },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, lastHeartbeatAt: true, startedAt: true },
    })
    expect(create).toHaveBeenCalledWith({
      data: {
        startedAt,
        lastHeartbeatAt: startedAt,
        status: 'running',
        staleAfterAt: new Date(startedAt.getTime() + staleThresholdMs),
      },
    })
    expect(upsert).toHaveBeenCalledWith({
      where: {
        kind_triggerType_triggerId: {
          kind: 'operation_cycle_refresh',
          triggerType: 'crawl_run',
          triggerId: 'run1',
        },
      },
      create: {
        kind: 'operation_cycle_refresh',
        triggerType: 'crawl_run',
        triggerId: 'run1',
      },
      update: {},
    })
  })

  it('reuses the newest interrupted run and refreshes its heartbeat', async () => {
    const startedAt = new Date('2026-07-28T00:00:00Z')
    const originalStartedAt = new Date('2026-07-27T22:00:00Z')
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run2',
      lastHeartbeatAt: new Date('2026-07-27T23:00:00Z'),
      startedAt: originalStartedAt,
    })
    let sqlQuery: TemplateStringsArray | undefined
    let requestedRunId: string | undefined
    const queryRaw = vi.fn((query: TemplateStringsArray, crawlRunId: string) => {
      sqlQuery = query
      requestedRunId = crawlRunId
      return Promise.resolve([
        { username: 'alice', status: 'failed', classificationStatus: 'failed' },
        { username: 'bob', status: 'partial', classificationStatus: 'partial' },
      ])
    })
    const create = vi.fn()
    const update = vi.fn()
    const upsert = vi.fn()
    const prisma = {
      crawlRun: { findFirst, create, update },
      analysisWorkItem: { upsert },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient

    const result = await startOrResumeCrawlRun(prisma, startedAt, staleThresholdMs)

    expect(result).toEqual({
      id: 'run2',
      latestAccountStatuses: new Map([
        ['alice', { status: 'failed', classificationStatus: 'failed' }],
        ['bob', { status: 'partial', classificationStatus: 'partial' }],
      ]),
      startedAt: originalStartedAt,
    })
    if (!sqlQuery) throw new Error('Expected the latest account status query')
    expect(sqlQuery.join('')).toContain(
      'SELECT DISTINCT ON ("username") "username", "status", "classificationStatus"',
    )
    expect(sqlQuery.join('')).toContain('WHERE "crawlRunId" = ')
    expect(sqlQuery.join('')).toContain('ORDER BY "username", "startedAt" DESC, "id" DESC')
    expect(requestedRunId).toBe('run2')
    expect(create).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith({
      where: { id: 'run2' },
      data: {
        lastHeartbeatAt: startedAt,
        staleAfterAt: new Date(startedAt.getTime() + staleThresholdMs),
      },
    })
  })

  it('abandons a running row whose heartbeat exceeds the stale threshold and starts a new run', async () => {
    const startedAt = new Date('2026-07-28T00:00:00Z')
    // lastHeartbeatAt は startedAt の 20 時間前とし、staleThresholdMs (18 時間) を超えさせる
    const lastHeartbeatAt = new Date(startedAt.getTime() - 20 * 60 * 60 * 1000)
    const findFirst = vi.fn().mockResolvedValue({
      id: 'abandoned-run',
      lastHeartbeatAt,
    })
    const create = vi.fn().mockResolvedValue({ id: 'new-run', startedAt })
    const update = vi.fn().mockResolvedValue({})
    const upsert = vi.fn().mockResolvedValue({})
    const upsertEvidenceEpoch = vi.fn().mockResolvedValue({})
    const deleteCheckpoints = vi.fn().mockReturnValue({})
    const deleteLabelClaims = vi.fn().mockReturnValue({})
    const tx = {
      crawlRun: { update, create },
      labelEvidenceEpoch: { upsert: upsertEvidenceEpoch },
      analysisWorkItem: { upsert },
    }
    const transaction = vi.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (transactionClient: unknown) => Promise<unknown>)(tx)
        : arg,
    )
    const prisma = {
      crawlRun: { findFirst, create, update },
      crawlAccountCheckpoint: { deleteMany: deleteCheckpoints },
      crawlAccountLabelRun: { deleteMany: deleteLabelClaims },
      $transaction: transaction,
    } as unknown as PrismaClient

    const result = await startOrResumeCrawlRun(prisma, startedAt, staleThresholdMs)

    expect(result).toEqual({ id: 'new-run', latestAccountStatuses: new Map(), startedAt })
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
    expect(upsert).toHaveBeenCalledWith({
      where: {
        kind_triggerType_triggerId: {
          kind: 'operation_cycle_refresh',
          triggerType: 'crawl_run',
          triggerId: 'new-run',
        },
      },
      create: {
        kind: 'operation_cycle_refresh',
        triggerType: 'crawl_run',
        triggerId: 'new-run',
      },
      update: {},
    })
  })

  it('resumes a running row exactly at the stale threshold boundary (not stale)', async () => {
    const startedAt = new Date('2026-07-28T00:00:00Z')
    const lastHeartbeatAt = new Date(startedAt.getTime() - staleThresholdMs)
    const findFirst = vi.fn().mockResolvedValue({ id: 'run3', lastHeartbeatAt })
    const queryRaw = vi.fn().mockResolvedValue([])
    const create = vi.fn()
    const update = vi.fn()
    const upsert = vi.fn()
    const prisma = {
      crawlRun: { findFirst, create, update },
      analysisWorkItem: { upsert },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient

    const result = await startOrResumeCrawlRun(prisma, startedAt, staleThresholdMs)

    expect(result.id).toBe('run3')
    expect(create).not.toHaveBeenCalled()
    expect(upsert).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith({
      where: { id: 'run3' },
      data: {
        lastHeartbeatAt: startedAt,
        staleAfterAt: new Date(startedAt.getTime() + staleThresholdMs),
      },
    })
  })

  it('returns the persisted startedAt for a newly created run', async () => {
    const startedAt = new Date('2026-01-01T00:00:00Z')
    const findFirst = vi.fn().mockResolvedValue(null)
    const create = vi.fn().mockResolvedValue({ id: 'run1', startedAt })
    const upsert = vi.fn().mockResolvedValue({})
    const tx = { crawlRun: { create }, analysisWorkItem: { upsert } }
    const transaction = vi.fn((fn: (transactionClient: unknown) => Promise<unknown>) => fn(tx))
    const prisma = {
      crawlRun: { findFirst, create },
      $transaction: transaction,
    } as unknown as PrismaClient

    const result = await startOrResumeCrawlRun(prisma, startedAt, staleThresholdMs)

    expect(result.startedAt).toEqual(startedAt)
  })

  it('returns the ORIGINAL persisted startedAt (not the resume-time argument) when resuming', async () => {
    const originalStartedAt = new Date('2026-01-01T00:00:00Z')
    const resumeTimeArgument = new Date('2026-01-01T01:00:00Z')
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run2',
      lastHeartbeatAt: new Date('2026-01-01T00:30:00Z'),
      startedAt: originalStartedAt,
    })
    const queryRaw = vi.fn().mockResolvedValue([])
    const update = vi.fn().mockResolvedValue({})
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = {
      crawlRun: { findFirst, create: vi.fn(), update },
      analysisWorkItem: { upsert },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient

    const result = await startOrResumeCrawlRun(prisma, resumeTimeArgument, staleThresholdMs)

    expect(result.startedAt).toEqual(originalStartedAt)
    expect(result.startedAt).not.toEqual(resumeTimeArgument)
  })
})

describe('finishCrawlRun', () => {
  it('publishes exactly one evidence epoch before enqueueing the crawl refresh', async () => {
    const finishedAt = new Date('2026-08-13T12:00:00Z')
    const update = vi.fn().mockResolvedValue({})
    const upsert = vi.fn().mockResolvedValue({ id: 'epoch-1' })
    const enqueue = vi.fn().mockResolvedValue({})
    const tx = {
      crawlRun: { update },
      labelEvidenceEpoch: { upsert },
      analysisWorkItem: { upsert: enqueue },
    }
    const transaction = vi.fn((fn: (transactionClient: unknown) => Promise<unknown>) => fn(tx))
    const prisma = { $transaction: transaction } as unknown as PrismaClient

    await finishCrawlRun(prisma, 'crawl-1', finishedAt, 'partial')

    expect(upsert).toHaveBeenCalledWith({
      where: { crawlRunId: 'crawl-1' },
      create: { crawlRunId: 'crawl-1', sourceWatermarkAt: finishedAt },
      update: {},
    })
    expect(enqueue).toHaveBeenCalledWith({
      where: {
        kind_triggerType_triggerId: {
          kind: 'label_aggregate_refresh',
          triggerType: 'crawl_run',
          triggerId: 'crawl-1',
        },
      },
      create: {
        kind: 'label_aggregate_refresh',
        triggerType: 'crawl_run',
        triggerId: 'crawl-1',
      },
      update: {},
    })
    expect(upsert.mock.invocationCallOrder[0]).toBeLessThan(enqueue.mock.invocationCallOrder[0])
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
    const upsert = vi.fn().mockResolvedValue({})
    const upsertEvidenceEpoch = vi.fn().mockResolvedValue({})
    const tx = {
      crawlRun: { update },
      labelEvidenceEpoch: { upsert: upsertEvidenceEpoch },
      analysisWorkItem: { upsert },
    }
    const prisma = {
      $transaction: vi.fn((fn: (tx: unknown) => Promise<void>) => fn(tx)),
    } as unknown as PrismaClient
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

  // consumer 側 (analyzer/operations/build-crawl-cycle.test.ts) がここで固定する
  // kind/triggerType/triggerId をそのまま再利用し、契約の崩れを検出する。
  it('enqueues a label_aggregate_refresh AnalysisWorkItem for the finished run', async () => {
    const update = vi.fn().mockResolvedValue({})
    const upsert = vi.fn().mockResolvedValue({})
    const upsertEvidenceEpoch = vi.fn().mockResolvedValue({})
    const tx = {
      crawlRun: { update },
      labelEvidenceEpoch: { upsert: upsertEvidenceEpoch },
      analysisWorkItem: { upsert },
    }
    const prisma = {
      $transaction: vi.fn((fn: (tx: unknown) => Promise<void>) => fn(tx)),
    } as unknown as PrismaClient

    await finishCrawlRun(prisma, 'run1', new Date('2026-07-28T01:00:00Z'), 'failed')

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          kind_triggerType_triggerId: {
            kind: 'label_aggregate_refresh',
            triggerType: 'crawl_run',
            triggerId: 'run1',
          },
        },
      }),
    )
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
      parentTweetFetchCount: 6,
      followingSynced: true,
      followersSynced: true,
      blocksSynced: true,
      warnings: [],
      errorMessage: null,
      appVersion: 'v1.2.3',
      classificationStatus: 'success',
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
        parentTweetFetchCount: 6,
        followingSynced: true,
        followersSynced: true,
        blocksSynced: true,
        warnings: [],
        errorMessage: null,
        appVersion: 'v1.2.3',
        classificationStatus: 'success',
      },
    })
  })
})

describe('CRAWL_ACCOUNT_CHECKPOINT_PHASES', () => {
  it('includes the replies phase between timelines and authors', () => {
    expect(CRAWL_ACCOUNT_CHECKPOINT_PHASES).toEqual([
      'timelines',
      'replies',
      'authors',
      'following',
      'followers',
      'blocks',
    ])
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
    const authorCheckpointOperation = {} as ReturnType<
      PrismaClient['crawlAuthorCheckpoint']['deleteMany']
    >
    const deleteCheckpoints = vi.fn().mockReturnValue(checkpointOperation)
    const deleteLabelClaims = vi.fn().mockReturnValue(labelClaimOperation)
    const deleteAuthorCheckpoints = vi.fn().mockReturnValue(authorCheckpointOperation)
    const transaction = vi.fn().mockResolvedValue([])
    const prisma = {
      crawlAccountCheckpoint: { deleteMany: deleteCheckpoints },
      crawlAccountLabelRun: { deleteMany: deleteLabelClaims },
      crawlAuthorCheckpoint: { deleteMany: deleteAuthorCheckpoints },
      $transaction: transaction,
    } as unknown as PrismaClient

    await clearCrawlAccountCheckpoints(prisma, 'run1')

    expect(deleteCheckpoints).toHaveBeenCalledWith({ where: { crawlRunId: 'run1' } })
    expect(deleteLabelClaims).toHaveBeenCalledWith({ where: { crawlRunId: 'run1' } })
    expect(deleteAuthorCheckpoints).toHaveBeenCalledWith({ where: { crawlRunId: 'run1' } })
    expect(transaction).toHaveBeenCalledWith([
      checkpointOperation,
      labelClaimOperation,
      authorCheckpointOperation,
    ])
  })
})

describe('crawl author checkpoints', () => {
  it('upserts an author checkpoint by crawl run, account, and author', async () => {
    const upsert = vi.fn().mockResolvedValue({})
    const prisma = {
      crawlAuthorCheckpoint: { upsert },
    } as unknown as PrismaClient

    await recordCrawlAuthorCheckpoint(prisma, {
      crawlRunId: 'run1',
      username: 'someuser',
      authorId: 'author1',
      status: 'success',
      profileCount: 1,
      labelsAppliedCount: 2,
      warnings: [],
      durationMs: 100,
      retryWaitMs: 0,
      followSampleStatus: 'fetched',
      followSampleRequestCount: 1,
      followSampleRateLimitRemaining: 0,
      followSampleRateLimitReset: 1_760_000_000,
      parentTweetFetchRequestCount: 2,
      parentTweetFetchRateLimitRemaining: 10,
      parentTweetFetchRateLimitReset: 1_760_000_100,
      appVersion: 'test',
    })

    expect(upsert).toHaveBeenCalledWith({
      where: {
        crawlRunId_username_authorId: {
          crawlRunId: 'run1',
          username: 'someuser',
          authorId: 'author1',
        },
      },
      create: {
        crawlRunId: 'run1',
        username: 'someuser',
        authorId: 'author1',
        status: 'success',
        profileCount: 1,
        labelsAppliedCount: 2,
        warnings: [],
        followSampleStatus: 'fetched',
        followSampleRequestCount: 1,
        followSampleRateLimitRemaining: 0,
        followSampleRateLimitReset: 1_760_000_000,
        parentTweetFetchRequestCount: 2,
        parentTweetFetchRateLimitRemaining: 10,
        parentTweetFetchRateLimitReset: 1_760_000_100,
        durationMs: 100,
        retryWaitMs: 0,
        appVersion: 'test',
      },
      update: {
        status: 'success',
        profileCount: 1,
        labelsAppliedCount: 2,
        warnings: [],
        durationMs: 100,
        retryWaitMs: 0,
        followSampleStatus: 'fetched',
        followSampleRequestCount: 1,
        followSampleRateLimitRemaining: 0,
        followSampleRateLimitReset: 1_760_000_000,
        parentTweetFetchRequestCount: 2,
        parentTweetFetchRateLimitRemaining: 10,
        parentTweetFetchRateLimitReset: 1_760_000_100,
        appVersion: 'test',
        completedAt: expect.any(Date),
      },
    })
  })

  it('loads author checkpoints keyed by authorId', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        authorId: 'author1',
        status: 'success',
        profileCount: 1,
        labelsAppliedCount: 2,
        warnings: [],
        followSampleStatus: 'fetched',
        followSampleRequestCount: 1,
        followSampleRateLimitRemaining: 0,
        followSampleRateLimitReset: 1_760_000_000,
        parentTweetFetchRequestCount: 2,
        parentTweetFetchRateLimitRemaining: 10,
        parentTweetFetchRateLimitReset: 1_760_000_100,
      },
      {
        authorId: 'author2',
        status: 'unavailable',
        profileCount: 0,
        labelsAppliedCount: 0,
        warnings: [{ type: 'author_processing_failed', message: 'm', errorMessage: 'e' }],
        followSampleStatus: null,
        followSampleRequestCount: 0,
        followSampleRateLimitRemaining: null,
        followSampleRateLimitReset: null,
        parentTweetFetchRequestCount: 0,
        parentTweetFetchRateLimitRemaining: null,
        parentTweetFetchRateLimitReset: null,
      },
      {
        authorId: 'author3',
        status: 'success',
        profileCount: 1,
        labelsAppliedCount: 1,
        warnings: [],
        followSampleStatus: 'unavailable',
        followSampleRequestCount: 1,
        followSampleRateLimitRemaining: null,
        followSampleRateLimitReset: null,
        parentTweetFetchRequestCount: 0,
        parentTweetFetchRateLimitRemaining: null,
        parentTweetFetchRateLimitReset: null,
      },
    ])
    const prisma = {
      crawlAuthorCheckpoint: { findMany },
    } as unknown as PrismaClient

    const result = await loadCrawlAuthorCheckpoints(prisma, 'run1', 'someuser')

    expect(result).toEqual(
      new Map([
        [
          'author1',
          {
            status: 'success',
            profileCount: 1,
            labelsAppliedCount: 2,
            warnings: [],
            followSampleStatus: 'fetched',
            followSampleRequestCount: 1,
            followSampleRateLimitRemaining: 0,
            followSampleRateLimitReset: 1_760_000_000,
            parentTweetFetchRequestCount: 2,
            parentTweetFetchRateLimitRemaining: 10,
            parentTweetFetchRateLimitReset: 1_760_000_100,
          },
        ],
        [
          'author2',
          {
            status: 'unavailable',
            profileCount: 0,
            labelsAppliedCount: 0,
            warnings: [{ type: 'author_processing_failed', message: 'm', errorMessage: 'e' }],
            followSampleStatus: null,
            followSampleRequestCount: 0,
            followSampleRateLimitRemaining: null,
            followSampleRateLimitReset: null,
            parentTweetFetchRequestCount: 0,
            parentTweetFetchRateLimitRemaining: null,
            parentTweetFetchRateLimitReset: null,
          },
        ],
        [
          'author3',
          {
            status: 'success',
            profileCount: 1,
            labelsAppliedCount: 1,
            warnings: [],
            followSampleStatus: 'unavailable',
            followSampleRequestCount: 1,
            followSampleRateLimitRemaining: null,
            followSampleRateLimitReset: null,
            parentTweetFetchRequestCount: 0,
            parentTweetFetchRateLimitRemaining: null,
            parentTweetFetchRateLimitReset: null,
          },
        ],
      ]),
    )
    expect(findMany).toHaveBeenCalledWith({
      where: { crawlRunId: 'run1', username: 'someuser' },
      select: {
        authorId: true,
        status: true,
        profileCount: true,
        labelsAppliedCount: true,
        warnings: true,
        followSampleStatus: true,
        followSampleRequestCount: true,
        followSampleRateLimitRemaining: true,
        followSampleRateLimitReset: true,
        parentTweetFetchRequestCount: true,
        parentTweetFetchRateLimitRemaining: true,
        parentTweetFetchRateLimitReset: true,
      },
    })
  })
})
