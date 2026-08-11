import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import type { FollowListResult } from '../twitter/follows'
import * as accountRepository from './account-repository'
import {
  replaceLabelingFollowSample,
  replaceLabelingFollowSampleWithinTx,
  upsertFollowSampleAuthors,
} from './labeling-follow-sample-repository'

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

function makePrisma(upsertedIds?: Set<string>) {
  const upsertAccountsBulkSpy = vi.spyOn(accountRepository, 'upsertAccountsBulk')
  if (upsertedIds) {
    upsertAccountsBulkSpy.mockResolvedValue(upsertedIds)
  }
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 })
  const createMany = vi.fn().mockResolvedValue({ count: 0 })
  const tx = {
    labelingFollowSample: { deleteMany, createMany },
  }
  const $transaction = vi
    .fn()
    .mockImplementation((fn: (transactionClient: typeof tx) => Promise<void>) => fn(tx))
  const prisma = {
    $transaction,
  } as unknown as PrismaClient
  return { prisma, upsertAccountsBulkSpy, deleteMany, createMany, $transaction }
}

describe('upsertFollowSampleAuthors', () => {
  it('delegates to upsertAccountsBulk and returns its succeeded id set', async () => {
    const { prisma, upsertAccountsBulkSpy } = makePrisma(new Set(['bob', 'carol']))

    const result = await upsertFollowSampleAuthors(prisma, makeResult(['bob', 'carol']))

    expect(upsertAccountsBulkSpy).toHaveBeenCalledTimes(1)
    expect(result).toEqual(new Set(['bob', 'carol']))
  })
})

describe('replaceLabelingFollowSample', () => {
  it('取得した各フォロー先を bulk upsert する', async () => {
    const { prisma, upsertAccountsBulkSpy } = makePrisma(new Set(['bob', 'carol']))

    await replaceLabelingFollowSample(prisma, 'alice', makeResult(['bob', 'carol']))

    expect(upsertAccountsBulkSpy).toHaveBeenCalledTimes(1)
  })

  it('既存のサンプル行を削除してから今回取得した分だけを挿入する', async () => {
    const { prisma, deleteMany, createMany } = makePrisma(new Set(['bob', 'carol']))

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

  it('チェックポイント滞留を吸収できるよう、既定より長いトランザクションタイムアウトを指定する', async () => {
    const { prisma, $transaction } = makePrisma(new Set(['bob']))

    await replaceLabelingFollowSample(prisma, 'alice', makeResult(['bob']))

    expect($transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 15_000,
      timeout: 15_000,
    })
  })

  it('フォロー先が0件の場合は削除も挿入も行わず、既存サンプルを残す', async () => {
    const { prisma, deleteMany, createMany } = makePrisma(new Set())

    await replaceLabelingFollowSample(prisma, 'alice', makeResult([]))

    expect(deleteMany).not.toHaveBeenCalled()
    expect(createMany).not.toHaveBeenCalled()
  })

  it('1件のフォロー先アカウントの upsert が失敗しても残りの処理を続ける', async () => {
    const { prisma, createMany } = makePrisma(new Set(['carol']))

    await replaceLabelingFollowSample(prisma, 'alice', makeResult(['bob', 'carol']))

    // Account の upsert に失敗した bob は外部キー制約に違反するため、
    // 挿入対象から除外し carol のみを渡す。
    expect(createMany).toHaveBeenCalledWith({
      data: [{ accountId: 'alice', followeeId: 'carol' }],
      skipDuplicates: true,
    })
  })

  it('取得した全フォロー先の upsert が失敗した場合も削除を行わず、既存サンプルを残す', async () => {
    const { prisma, deleteMany, createMany } = makePrisma(new Set())

    await replaceLabelingFollowSample(prisma, 'alice', makeResult(['bob', 'carol']))

    expect(deleteMany).not.toHaveBeenCalled()
    expect(createMany).not.toHaveBeenCalled()
  })
})

describe('replaceLabelingFollowSampleWithinTx', () => {
  it('自前で transaction を開かずにサンプル行を置き換える', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 })
    const createMany = vi.fn().mockResolvedValue({ count: 2 })
    const txClient = {
      labelingFollowSample: { deleteMany, createMany },
    } as unknown as PrismaClient

    await replaceLabelingFollowSampleWithinTx(txClient, 'alice', ['bob', 'carol'])

    expect(deleteMany).toHaveBeenCalledWith({ where: { accountId: 'alice' } })
    expect(createMany).toHaveBeenCalledWith({
      data: [
        { accountId: 'alice', followeeId: 'bob' },
        { accountId: 'alice', followeeId: 'carol' },
      ],
      skipDuplicates: true,
    })
  })

  it('followeeId が0件の場合は何もしない', async () => {
    const deleteMany = vi.fn()
    const txClient = { labelingFollowSample: { deleteMany } } as unknown as PrismaClient

    await replaceLabelingFollowSampleWithinTx(txClient, 'alice', [])

    expect(deleteMany).not.toHaveBeenCalled()
  })
})
