import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { BlockListResult } from '../twitter/blocks'
import { syncBlocks } from './block-repository'

function makeResult(ids: string[], reachedEnd: boolean): BlockListResult {
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

function makePrisma() {
  const accountUpsert = vi.fn().mockResolvedValue({})
  const blockCreateMany = vi.fn().mockResolvedValue({ count: 0 })
  const blockUpdateMany = vi.fn().mockResolvedValue({ count: 0 })
  const blockDeleteMany = vi.fn().mockResolvedValue({ count: 0 })
  const tx = {
    account: { upsert: accountUpsert },
    block: {
      createMany: blockCreateMany,
      updateMany: blockUpdateMany,
      deleteMany: blockDeleteMany,
    },
  }
  const $transaction = vi
    .fn()
    .mockImplementation((fn: (transactionClient: typeof tx) => Promise<void>) => fn(tx))
  const prisma = {
    account: { upsert: accountUpsert },
    $transaction,
  } as unknown as PrismaClient
  return { prisma, accountUpsert, blockCreateMany, blockUpdateMany, blockDeleteMany }
}

describe('syncBlocks', () => {
  it('upserts an Account row for every discovered author', async () => {
    const { prisma, accountUpsert } = makePrisma()

    await syncBlocks(prisma, 'me', makeResult(['a', 'b'], true))

    expect(accountUpsert).toHaveBeenCalledTimes(2)
  })

  it('creates a Block edge for every id with blockerId fixed to the given account', async () => {
    const { prisma, blockCreateMany } = makePrisma()

    await syncBlocks(prisma, 'me', makeResult(['a', 'b'], true))

    expect(blockCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ blockerId: 'me', blockedId: 'a' }),
          expect.objectContaining({ blockerId: 'me', blockedId: 'b' }),
        ],
        skipDuplicates: true,
      }),
    )
  })

  it('bumps lastSeenAt for every id with blockerId fixed to the given account', async () => {
    const { prisma, blockUpdateMany } = makePrisma()

    await syncBlocks(prisma, 'me', makeResult(['a', 'b'], true))

    expect(blockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { blockerId: 'me', blockedId: { in: ['a', 'b'] } },
      }),
    )
  })

  it('deletes stale edges for the same blocker when reachedEnd is true', async () => {
    const { prisma, blockDeleteMany } = makePrisma()

    await syncBlocks(prisma, 'me', makeResult(['a'], true))

    expect(blockDeleteMany).toHaveBeenCalledWith({
      where: { blockerId: 'me', blockedId: { notIn: ['a'] } },
    })
  })

  it('does not delete anything when reachedEnd is false', async () => {
    const { prisma, blockDeleteMany } = makePrisma()

    await syncBlocks(prisma, 'me', makeResult(['a'], false))

    expect(blockDeleteMany).not.toHaveBeenCalled()
  })

  it('does not delete anything when reachedEnd is true but no ids were observed', async () => {
    const { prisma, blockDeleteMany, blockCreateMany } = makePrisma()

    await syncBlocks(prisma, 'me', makeResult([], true))

    expect(blockDeleteMany).not.toHaveBeenCalled()
    expect(blockCreateMany).not.toHaveBeenCalled()
  })
})
