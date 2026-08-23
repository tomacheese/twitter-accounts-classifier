import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { FollowListResult } from '../twitter/follows'
import * as accountRepository from './account-repository'
import { syncFollowers, syncFollowing } from './follow-repository'

function makeResult(ids: string[], reachedEnd: boolean): FollowListResult {
  return {
    ids,
    authors: ids.map((id) => ({
      id,
      screenName: `user_${id}`,
      displayName: `User ${id}`,
      bio: null,
      profileImageUrl: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      location: null,
      url: null,
      isBlueVerified: false,
      verifiedType: null,
      professionalType: null,
      parodyCommentaryFanLabel: null,
    })),
    reachedEnd,
  }
}

function makePrisma(
  upsertedIds: Set<string>,
  addedEdges: { followerId: string; followeeId: string }[] = [],
  removedEdges: { followerId: string; followeeId: string }[] = [],
) {
  const upsertAccountsBulkSpy = vi
    .spyOn(accountRepository, 'upsertAccountsBulk')
    .mockResolvedValue(upsertedIds)
  const followUpdateMany = vi.fn().mockResolvedValue({ count: 0 })
  const followStateChangeCreateMany = vi.fn().mockResolvedValue({ count: 0 })
  const queryRaw = vi.fn().mockResolvedValueOnce(addedEdges).mockResolvedValueOnce(removedEdges)
  const tx = {
    follow: {
      updateMany: followUpdateMany,
    },
    followStateChange: { createMany: followStateChangeCreateMany },
    $queryRaw: queryRaw,
  }
  const $transaction = vi
    .fn()
    .mockImplementation((fn: (transactionClient: typeof tx) => Promise<void>) => fn(tx))
  const prisma = {
    $transaction,
  } as unknown as PrismaClient
  return {
    prisma,
    upsertAccountsBulkSpy,
    followUpdateMany,
    followStateChangeCreateMany,
    queryRaw,
    $transaction,
  }
}

describe('syncFollowing', () => {
  it('bulk upserts every discovered author in a single call', async () => {
    const { prisma, upsertAccountsBulkSpy } = makePrisma(new Set(['a', 'b']))

    await syncFollowing(prisma, 'me', makeResult(['a', 'b'], true))

    expect(upsertAccountsBulkSpy).toHaveBeenCalledTimes(1)
  })

  it('records followed only for edges returned by INSERT ... ON CONFLICT DO NOTHING', async () => {
    const { prisma, followStateChangeCreateMany } = makePrisma(new Set(['a', 'b']), [
      { followerId: 'me', followeeId: 'a' },
    ])

    await syncFollowing(prisma, 'me', makeResult(['a', 'b'], true))

    expect(followStateChangeCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ followerId: 'me', followeeId: 'a', changeType: 'followed' }),
      ],
    })
  })

  it('bumps lastSeenAt for every id with followerId fixed to the given account', async () => {
    const { prisma, followUpdateMany } = makePrisma(new Set(['a', 'b']))

    await syncFollowing(prisma, 'me', makeResult(['a', 'b'], true))

    expect(followUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { followerId: 'me', followeeId: { in: ['a', 'b'] } },
      }),
    )
  })

  it('records unfollowed only for edges returned by DELETE ... RETURNING', async () => {
    const { prisma, followStateChangeCreateMany } = makePrisma(
      new Set(['a']),
      [],
      [{ followerId: 'me', followeeId: 'stale' }],
    )

    await syncFollowing(prisma, 'me', makeResult(['a'], true))

    expect(followStateChangeCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          followerId: 'me',
          followeeId: 'stale',
          changeType: 'unfollowed',
        }),
      ],
    })
  })

  it('does not record unfollowed when the observation is incomplete', async () => {
    const { prisma, followStateChangeCreateMany, queryRaw } = makePrisma(new Set(['a']))

    await syncFollowing(prisma, 'me', makeResult(['a'], false))

    expect(queryRaw).toHaveBeenCalledTimes(1)
    expect(followStateChangeCreateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.arrayContaining([expect.objectContaining({ changeType: 'unfollowed' })]),
      }),
    )
  })

  it('does not delete anything when reachedEnd is true but no ids were observed', async () => {
    const { prisma, queryRaw } = makePrisma(new Set())

    await syncFollowing(prisma, 'me', makeResult([], true))

    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('deduplicates ids before inserting Follow edges', async () => {
    const { prisma, queryRaw, followStateChangeCreateMany } = makePrisma(new Set(['ok1']))

    await syncFollowing(prisma, 'me', makeResult(['ok1', 'ok1'], true))

    const ids = queryRaw.mock.calls[0][5] as string[]
    expect(ids).toEqual(['ok1'])
    expect(followStateChangeCreateMany).not.toHaveBeenCalled()
  })

  it('skips deletion when any observed id failed Account upsert', async () => {
    const { prisma, queryRaw } = makePrisma(new Set(['ok1']))

    await syncFollowing(prisma, 'me', makeResult(['ok1', 'ok1', 'bad1'], true))

    expect(queryRaw).toHaveBeenCalledTimes(1)
  })

  it('extends the transaction timeout beyond the Prisma default', async () => {
    const { prisma, $transaction } = makePrisma(new Set(['a']))

    await syncFollowing(prisma, 'me', makeResult(['a'], true))

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 15_000,
      timeout: 15_000,
    })
  })
})

describe('syncFollowers', () => {
  it('records followed for inserted edges with followeeId fixed to the given account', async () => {
    const { prisma, followStateChangeCreateMany } = makePrisma(new Set(['a']), [
      { followerId: 'a', followeeId: 'me' },
    ])

    await syncFollowers(prisma, 'me', makeResult(['a'], true))

    expect(followStateChangeCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ followerId: 'a', followeeId: 'me', changeType: 'followed' }),
      ],
    })
  })

  it('bumps lastSeenAt for every id with followeeId fixed to the given account', async () => {
    const { prisma, followUpdateMany } = makePrisma(new Set(['a']))

    await syncFollowers(prisma, 'me', makeResult(['a'], true))

    expect(followUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { followeeId: 'me', followerId: { in: ['a'] } },
      }),
    )
  })

  it('records unfollowed for deleted edges with followeeId fixed to the given account', async () => {
    const { prisma, followStateChangeCreateMany } = makePrisma(
      new Set(['a']),
      [],
      [{ followerId: 'stale', followeeId: 'me' }],
    )

    await syncFollowers(prisma, 'me', makeResult(['a'], true))

    expect(followStateChangeCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          followerId: 'stale',
          followeeId: 'me',
          changeType: 'unfollowed',
        }),
      ],
    })
  })

  it('does not delete anything when reachedEnd is true but no ids were observed', async () => {
    const { prisma, queryRaw } = makePrisma(new Set())

    await syncFollowers(prisma, 'me', makeResult([], true))

    expect(queryRaw).not.toHaveBeenCalled()
  })

  it('extends the transaction timeout beyond the Prisma default', async () => {
    const { prisma, $transaction } = makePrisma(new Set(['a']))

    await syncFollowers(prisma, 'me', makeResult(['a'], true))

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 15_000,
      timeout: 15_000,
    })
  })
})
