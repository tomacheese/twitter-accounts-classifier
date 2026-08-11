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

function makePrisma(upsertedIds: Set<string>) {
  const upsertAccountsBulkSpy = vi
    .spyOn(accountRepository, 'upsertAccountsBulk')
    .mockResolvedValue(upsertedIds)
  const followCreateMany = vi.fn().mockResolvedValue({ count: 0 })
  const followUpdateMany = vi.fn().mockResolvedValue({ count: 0 })
  const followDeleteMany = vi.fn().mockResolvedValue({ count: 0 })
  const tx = {
    follow: {
      createMany: followCreateMany,
      updateMany: followUpdateMany,
      deleteMany: followDeleteMany,
    },
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
    followCreateMany,
    followUpdateMany,
    followDeleteMany,
    $transaction,
  }
}

describe('syncFollowing', () => {
  it('bulk upserts every discovered author in a single call', async () => {
    const { prisma, upsertAccountsBulkSpy } = makePrisma(new Set(['a', 'b']))

    await syncFollowing(prisma, 'me', makeResult(['a', 'b'], true))

    expect(upsertAccountsBulkSpy).toHaveBeenCalledTimes(1)
  })

  it('creates a Follow edge for every id with followerId fixed to the given account', async () => {
    const { prisma, followCreateMany } = makePrisma(new Set(['a', 'b']))

    await syncFollowing(prisma, 'me', makeResult(['a', 'b'], true))

    expect(followCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ followerId: 'me', followeeId: 'a' }),
          expect.objectContaining({ followerId: 'me', followeeId: 'b' }),
        ],
        skipDuplicates: true,
      }),
    )
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

  it('deletes stale edges for the same follower when reachedEnd is true', async () => {
    const { prisma, followDeleteMany } = makePrisma(new Set(['a']))

    await syncFollowing(prisma, 'me', makeResult(['a'], true))

    expect(followDeleteMany).toHaveBeenCalledWith({
      where: { followerId: 'me', followeeId: { notIn: ['a'] } },
    })
  })

  it('does not delete anything when reachedEnd is false', async () => {
    const { prisma, followDeleteMany } = makePrisma(new Set(['a']))

    await syncFollowing(prisma, 'me', makeResult(['a'], false))

    expect(followDeleteMany).not.toHaveBeenCalled()
  })

  it('does not delete anything when reachedEnd is true but no ids were observed', async () => {
    const { prisma, followDeleteMany, followCreateMany } = makePrisma(new Set())

    await syncFollowing(prisma, 'me', makeResult([], true))

    expect(followDeleteMany).not.toHaveBeenCalled()
    expect(followCreateMany).not.toHaveBeenCalled()
  })

  it('excludes Account upsert failures from edge createMany/updateMany', async () => {
    const { prisma, followCreateMany } = makePrisma(new Set(['ok1']))

    await syncFollowing(prisma, 'me', makeResult(['ok1', 'bad1'], true))

    const createCall = followCreateMany.mock.calls[0][0] as { data: { followeeId: string }[] }
    expect(createCall.data.map((d) => d.followeeId)).toEqual(['ok1'])
  })

  it('skips deletion when any observed id failed Account upsert', async () => {
    const { prisma, followDeleteMany } = makePrisma(new Set(['ok1']))

    await syncFollowing(prisma, 'me', makeResult(['ok1', 'ok1', 'bad1'], true))

    expect(followDeleteMany).not.toHaveBeenCalled()
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
  it('creates a Follow edge for every id with followeeId fixed to the given account', async () => {
    const { prisma, followCreateMany } = makePrisma(new Set(['a']))

    await syncFollowers(prisma, 'me', makeResult(['a'], true))

    expect(followCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ followerId: 'a', followeeId: 'me' })],
        skipDuplicates: true,
      }),
    )
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

  it('deletes stale edges for the same followee when reachedEnd is true', async () => {
    const { prisma, followDeleteMany } = makePrisma(new Set(['a']))

    await syncFollowers(prisma, 'me', makeResult(['a'], true))

    expect(followDeleteMany).toHaveBeenCalledWith({
      where: { followeeId: 'me', followerId: { notIn: ['a'] } },
    })
  })

  it('does not delete anything when reachedEnd is true but no ids were observed', async () => {
    const { prisma, followDeleteMany } = makePrisma(new Set())

    await syncFollowers(prisma, 'me', makeResult([], true))

    expect(followDeleteMany).not.toHaveBeenCalled()
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
