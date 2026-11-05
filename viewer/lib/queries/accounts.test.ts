import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { buildAccountOrderBy, getLabelKeys, listAccounts } from './accounts'

function buildPrisma(overrides: Record<string, unknown>): PrismaClient {
  const prisma = {
    account: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn(),
    ...overrides,
  }
  return {
    ...prisma,
    $transaction: vi.fn((callback: (tx: unknown) => Promise<unknown>) => callback(prisma)),
  } as unknown as PrismaClient
}

describe('listAccounts', () => {
  it('lists accounts with pagination and no label filter, attaching active label keys', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'a1',
        screenName: 'alice',
        displayName: 'Alice',
        followersCount: 100,
        tweetCount: 300,
        crawlState: { lastCrawledAt: new Date('2026-07-27T00:00:00Z') },
        isBlueVerified: true,
      },
    ])
    const count = vi.fn().mockResolvedValue(1)
    const queryRaw = vi.fn().mockResolvedValue([{ accountId: 'a1', key: 'spam' }])
    const prisma = buildPrisma({
      account: { findMany, count },
      $queryRaw: queryRaw,
    })

    const result = await listAccounts(prisma, {
      page: 1,
      pageSize: 20,
      sortBy: 'followersCount',
      sortDirection: 'desc',
    })

    expect(result).toEqual({
      items: [
        {
          id: 'a1',
          screenName: 'alice',
          displayName: 'Alice',
          followersCount: 100,
          tweetCount: 300,
          lastCrawledAt: new Date('2026-07-27T00:00:00Z'),
          isBlueVerified: true,
          activeLabelKeys: ['spam'],
        },
      ],
      totalCount: 1,
    })
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ followersCount: 'desc' }, { id: 'asc' }],
        skip: 0,
        take: 20,
        include: { crawlState: { select: { lastCrawledAt: true } } },
      }),
    )
  })

  it('bounds the list query with a transaction-local statement timeout', async () => {
    const executeRaw = vi.fn()
    const prisma = buildPrisma({ $executeRaw: executeRaw })

    await listAccounts(prisma, {
      page: 1,
      pageSize: 20,
      sortBy: 'tweetCount',
      sortDirection: 'asc',
    })

    const [strings, timeout] = executeRaw.mock.calls[0] as [string[], string]
    expect(strings.join('?')).toBe("SELECT set_config('statement_timeout', ?, true)")
    expect(timeout).toBe('20000')
    // Prisma の既定 (5 秒) で transaction が先に閉じないよう、2 文分の statement_timeout より長くする。
    expect(
      (prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction,
    ).toHaveBeenCalledWith(expect.any(Function), {
      timeout: 45_000,
    })
  })

  it('fails loudly when an account has no AccountCrawlState row', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'a9', crawlState: null }])
    const prisma = buildPrisma({ account: { findMany, count: vi.fn().mockResolvedValue(1) } })

    await expect(
      listAccounts(prisma, {
        page: 1,
        pageSize: 20,
        sortBy: 'followersCount',
        sortDirection: 'desc',
      }),
    ).rejects.toThrow('AccountCrawlState row is missing for account a9')
  })

  it('filters to accounts whose latest value is true for any given label key', async () => {
    // 1回目の呼び出しは findAccountIdsWithAnyLabel 自身の $queryRaw、
    // 2回目は getActiveLabelKeysByAccount のもの。
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([{ accountId: 'a2' }])
      .mockResolvedValueOnce([{ accountId: 'a2', key: 'bot' }])
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'a2',
        screenName: 'bob',
        displayName: 'Bob',
        followersCount: 10,
        tweetCount: 50,
        crawlState: { lastCrawledAt: new Date('2026-07-27T00:00:00Z') },
        isBlueVerified: false,
      },
    ])
    const count = vi.fn().mockResolvedValue(1)
    const prisma = buildPrisma({
      account: { findMany, count },
      $queryRaw: queryRaw,
    })

    await listAccounts(prisma, {
      labelKeys: ['bot'],
      page: 1,
      pageSize: 20,
      sortBy: 'followersCount',
      sortDirection: 'desc',
    })

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['a2'] } } }),
    )
  })

  it('returns an empty page without querying accounts when a label filter matches nothing', async () => {
    const findMany = vi.fn()
    const prisma = buildPrisma({
      account: { findMany, count: vi.fn() },
      $queryRaw: vi.fn().mockResolvedValue([]),
    })

    const result = await listAccounts(prisma, {
      labelKeys: ['nonexistent'],
      page: 1,
      pageSize: 20,
      sortBy: 'followersCount',
      sortDirection: 'desc',
    })

    expect(result).toEqual({ items: [], totalCount: 0 })
    expect(findMany).not.toHaveBeenCalled()
  })
})

describe('buildAccountOrderBy', () => {
  it('sorts lastCrawledAt through the crawlState relation and breaks ties by id', () => {
    expect(buildAccountOrderBy('lastCrawledAt', 'desc')).toEqual([
      { crawlState: { lastCrawledAt: 'desc' } },
      { id: 'asc' },
    ])
  })

  it('sorts profile columns directly', () => {
    expect(buildAccountOrderBy('tweetCount', 'asc')).toEqual([{ tweetCount: 'asc' }, { id: 'asc' }])
  })
})

describe('getLabelKeys', () => {
  it('returns every label key without loading trueCount/totalAccounts', async () => {
    const findMany = vi.fn().mockResolvedValue([{ key: 'bot' }, { key: 'spam' }])
    const prisma = {
      labelDefinition: { findMany },
    } as unknown as PrismaClient

    const result = await getLabelKeys(prisma)

    expect(result).toEqual(['bot', 'spam'])
    expect(findMany).toHaveBeenCalledWith({
      select: { key: true },
      orderBy: { key: 'asc' },
    })
  })
})
