import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getLabelKeys, listAccounts } from './accounts'

function buildPrisma(overrides: Record<string, unknown>): PrismaClient {
  return {
    account: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn(),
    $transaction: vi.fn().mockResolvedValue([undefined, []]),
    ...overrides,
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
        lastCrawledAt: new Date('2026-07-27T00:00:00Z'),
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
        orderBy: { followersCount: 'desc' },
        skip: 0,
        take: 20,
      }),
    )
  })

  it('filters to accounts whose latest value is true for any given label key', async () => {
    // The first call is findAccountIdsWithAnyLabel's own $queryRaw; the
    // second is getActiveLabelKeysByAccount's.
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
        lastCrawledAt: new Date('2026-07-27T00:00:00Z'),
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
