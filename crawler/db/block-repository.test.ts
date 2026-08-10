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
  rediscoveredBlocks: { id: string; status: string }[] = [],
) {
  const accountUpsert = vi.fn().mockResolvedValue({})
  const blockCreateMany = vi.fn().mockResolvedValue({ count: 0 })
  const blockUpdateMany = vi.fn().mockResolvedValue({ count: 0 })
  // 未取得の行を探す問い合わせと、再観測された行を探す問い合わせを where で区別する。
  const blockFindMany = vi
    .fn()
    .mockImplementation((args: { where: { blockedId: { in?: string[] } } }) =>
      Promise.resolve(args.where.blockedId.in ? rediscoveredBlocks : existingBlocks),
    )
  const executeRaw = vi.fn().mockResolvedValue(0)
  const blockStateChangeCreateMany = vi.fn().mockResolvedValue({ count: 0 })
  const tx = {
    account: { upsert: accountUpsert, findUnique: vi.fn().mockResolvedValue(null) },
    block: {
      createMany: blockCreateMany,
      updateMany: blockUpdateMany,
      findMany: blockFindMany,
    },
    blockStateChange: { createMany: blockStateChangeCreateMany },
    $executeRaw: executeRaw,
  }
  const $transaction = vi
    .fn()
    .mockImplementation((fn: (transactionClient: typeof tx) => Promise<void>) => fn(tx))
  const prisma = {
    account: { upsert: accountUpsert, findUnique: vi.fn().mockResolvedValue(null) },
    $transaction,
  } as unknown as PrismaClient
  return {
    prisma,
    accountUpsert,
    blockCreateMany,
    blockUpdateMany,
    blockFindMany,
    executeRaw,
    blockStateChangeCreateMany,
    $transaction,
  }
}

/**
 * @param blockFindMany - makePrisma が返す Block.findMany のモック
 * @returns 未取得の行を探す問い合わせだけを抜き出した呼び出し一覧
 */
function staleLookupCalls(blockFindMany: { mock: { calls: unknown[][] } }): unknown[][] {
  return blockFindMany.mock.calls.filter(
    (call) => (call[0] as { where: { blockedId: { notIn?: string[] } } }).where.blockedId.notIn,
  )
}

describe('syncBlocks', () => {
  it('upserts an Account row for every discovered author', async () => {
    const { prisma, accountUpsert } = makePrisma()

    await syncBlocks(prisma, 'me', 'crawl-run-1', makeResult(['a', 'b'], true))

    expect(accountUpsert).toHaveBeenCalledTimes(2)
  })

  it('creates a Block edge for every id with blockerId fixed to the given account', async () => {
    const { prisma, blockCreateMany } = makePrisma()

    await syncBlocks(prisma, 'me', 'crawl-run-1', makeResult(['a', 'b'], true))

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

  it('records crawl provenance on every newly created Block edge', async () => {
    const { prisma, blockCreateMany } = makePrisma()

    await syncBlocks(prisma, 'me', 'crawl-run-1', makeResult(['a', 'b'], true))

    expect(blockCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({ sourceKind: 'crawl', sourceId: 'crawl-run-1' }),
          expect.objectContaining({ sourceKind: 'crawl', sourceId: 'crawl-run-1' }),
        ],
      }),
    )
  })

  it('bumps lastSeenAt for every id with blockerId fixed to the given account', async () => {
    const { prisma, blockUpdateMany } = makePrisma()

    await syncBlocks(prisma, 'me', 'crawl-run-1', makeResult(['a', 'b'], true))

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
    const { prisma, executeRaw, blockStateChangeCreateMany } = makePrisma([existing])

    await syncBlocks(prisma, 'me', 'crawl-run-1', makeResult(['a'], true))

    expect(executeRaw).toHaveBeenCalledTimes(1)
    const [rawStrings, , ids, statuses, counts] = executeRaw.mock.calls[0] as [
      TemplateStringsArray,
      Date,
      string[],
      string[],
      number[],
    ]
    expect(rawStrings.join('')).toContain('UPDATE "Block"')
    expect(ids).toEqual(['block-1'])
    expect(statuses).toEqual(['missing'])
    expect(counts).toEqual([1])
    expect(blockStateChangeCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            blockId: 'block-1',
            fromStatus: 'active',
            toStatus: 'missing',
          }),
        ],
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

    await syncBlocks(prisma, 'me', 'crawl-run-1', makeResult(['a'], false))

    expect(staleLookupCalls(blockFindMany)).toHaveLength(0)
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

    await syncBlocks(prisma, 'me', 'crawl-run-1', makeResult([], true))

    expect(staleLookupCalls(blockFindMany)).toHaveLength(0)
    expect(blockCreateMany).not.toHaveBeenCalled()
  })

  it('restores a rediscovered edge to active and records the transition', async () => {
    const { prisma, blockUpdateMany, blockStateChangeCreateMany } = makePrisma(
      [],
      [{ id: 'block-1', status: 'resolved' }],
    )

    await syncBlocks(prisma, 'me', 'crawl-run-1', makeResult(['a'], true))

    expect(blockUpdateMany).toHaveBeenCalledWith({
      where: { id: { in: ['block-1'] } },
      data: expect.objectContaining({
        status: 'active',
        consecutiveMissingCount: 0,
        missingSinceAt: null,
        resolvedAt: null,
      }),
    })
    expect(blockStateChangeCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          blockId: 'block-1',
          fromStatus: 'resolved',
          toStatus: 'active',
        }),
      ],
    })
  })

  it('extends the transaction timeout beyond the Prisma default', async () => {
    const { prisma, $transaction } = makePrisma()

    await syncBlocks(prisma, 'me', 'crawl-run-1', makeResult(['a'], true))

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 15_000,
      timeout: 15_000,
    })
  })
})
