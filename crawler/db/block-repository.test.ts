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

function makePrisma(
  existingBlocks: {
    id: string
    blockedId: string
    status: string
    consecutiveMissingCount: number
    missingSinceAt: Date | null
  }[] = [],
) {
  const accountUpsert = vi.fn().mockResolvedValue({})
  const blockCreateMany = vi.fn().mockResolvedValue({ count: 0 })
  const blockUpdateMany = vi.fn().mockResolvedValue({ count: 0 })
  const blockFindMany = vi.fn().mockResolvedValue(existingBlocks)
  const blockUpdate = vi.fn().mockResolvedValue({})
  const blockStateChangeCreate = vi.fn().mockResolvedValue({})
  const tx = {
    account: { upsert: accountUpsert },
    block: {
      createMany: blockCreateMany,
      updateMany: blockUpdateMany,
      findMany: blockFindMany,
      update: blockUpdate,
    },
    blockStateChange: { create: blockStateChangeCreate },
  }
  const $transaction = vi
    .fn()
    .mockImplementation((fn: (transactionClient: typeof tx) => Promise<void>) => fn(tx))
  const prisma = {
    account: { upsert: accountUpsert },
    $transaction,
  } as unknown as PrismaClient
  return {
    prisma,
    accountUpsert,
    blockCreateMany,
    blockUpdateMany,
    blockFindMany,
    blockUpdate,
    blockStateChangeCreate,
    $transaction,
  }
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

  it('moves a stale edge to missing (not physically deleted) when reachedEnd is true', async () => {
    const existing = {
      id: 'block-1',
      blockedId: 'stale',
      status: 'active',
      consecutiveMissingCount: 0,
      missingSinceAt: null,
    }
    const { prisma, blockUpdate, blockStateChangeCreate } = makePrisma([existing])

    await syncBlocks(prisma, 'me', makeResult(['a'], true))

    expect(blockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'block-1' },
        data: expect.objectContaining({ status: 'missing', consecutiveMissingCount: 1 }),
      }),
    )
    expect(blockStateChangeCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          blockId: 'block-1',
          fromStatus: 'active',
          toStatus: 'missing',
        }),
      }),
    )
  })

  it('does not reconcile anything when reachedEnd is false', async () => {
    const existing = {
      id: 'block-1',
      blockedId: 'stale',
      status: 'active',
      consecutiveMissingCount: 0,
      missingSinceAt: null,
    }
    const { prisma, blockFindMany } = makePrisma([existing])

    await syncBlocks(prisma, 'me', makeResult(['a'], false))

    expect(blockFindMany).not.toHaveBeenCalled()
  })

  it('does not reconcile anything when reachedEnd is true but no ids were observed', async () => {
    const existing = {
      id: 'block-1',
      blockedId: 'stale',
      status: 'active',
      consecutiveMissingCount: 0,
      missingSinceAt: null,
    }
    const { prisma, blockFindMany, blockCreateMany } = makePrisma([existing])

    await syncBlocks(prisma, 'me', makeResult([], true))

    expect(blockFindMany).not.toHaveBeenCalled()
    expect(blockCreateMany).not.toHaveBeenCalled()
  })

  it('extends the transaction timeout beyond the Prisma default', async () => {
    const { prisma, $transaction } = makePrisma()

    await syncBlocks(prisma, 'me', makeResult(['a'], true))

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 15_000,
      timeout: 15_000,
    })
  })
})
