import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { FollowListResult } from '../twitter/follows'
import { replaceLabelingFollowSample } from './labeling-follow-sample-repository'

function makeResult(ids: string[]): FollowListResult {
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
    reachedEnd: true,
  }
}

function makePrisma() {
  const accountUpsert = vi.fn().mockResolvedValue({})
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 })
  const createMany = vi.fn().mockResolvedValue({ count: 0 })
  const tx = {
    labelingFollowSample: { deleteMany, createMany },
  }
  const $transaction = vi
    .fn()
    .mockImplementation((fn: (transactionClient: typeof tx) => Promise<void>) => fn(tx))
  const prisma = {
    account: { upsert: accountUpsert },
    $transaction,
  } as unknown as PrismaClient
  return { prisma, accountUpsert, deleteMany, createMany }
}

describe('replaceLabelingFollowSample', () => {
  it('取得した各フォロー先について Account 行を upsert する', async () => {
    const { prisma, accountUpsert } = makePrisma()

    await replaceLabelingFollowSample(prisma, 'alice', makeResult(['bob', 'carol']))

    expect(accountUpsert).toHaveBeenCalledTimes(2)
  })

  it('既存のサンプル行を削除してから今回取得した分だけを挿入する', async () => {
    const { prisma, deleteMany, createMany } = makePrisma()

    await replaceLabelingFollowSample(prisma, 'alice', makeResult(['bob', 'carol']))

    expect(deleteMany).toHaveBeenCalledWith({ where: { accountId: 'alice' } })
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { accountId: 'alice', followeeId: 'bob' },
        { accountId: 'alice', followeeId: 'carol' },
      ],
      skipDuplicates: true,
    })
  })

  it('フォロー先が0件の場合は削除も挿入も行わず、既存サンプルを残す', async () => {
    const { prisma, deleteMany, createMany } = makePrisma()

    await replaceLabelingFollowSample(prisma, 'alice', makeResult([]))

    expect(deleteMany).not.toHaveBeenCalled()
    expect(createMany).not.toHaveBeenCalled()
  })

  it('1件のフォロー先アカウントの upsert が失敗しても残りの処理を続ける', async () => {
    const { prisma, accountUpsert, createMany } = makePrisma()
    accountUpsert.mockRejectedValueOnce(new Error('upsert failed')).mockResolvedValue({})

    await replaceLabelingFollowSample(prisma, 'alice', makeResult(['bob', 'carol']))

    // Account の upsert に失敗した bob は外部キー制約に違反するため、
    // 挿入対象から除外し carol のみを渡す。
    expect(createMany).toHaveBeenCalledWith({
      data: [{ accountId: 'alice', followeeId: 'carol' }],
      skipDuplicates: true,
    })
  })

  it('取得した全フォロー先の upsert が失敗した場合も削除を行わず、既存サンプルを残す', async () => {
    const { prisma, accountUpsert, deleteMany, createMany } = makePrisma()
    accountUpsert.mockRejectedValue(new Error('upsert failed'))

    await replaceLabelingFollowSample(prisma, 'alice', makeResult(['bob', 'carol']))

    expect(deleteMany).not.toHaveBeenCalled()
    expect(createMany).not.toHaveBeenCalled()
  })
})
