import { describe, expect, it, vi } from 'vitest'
import { loadSelfReplyPromoCorpus } from './self-reply-promo-corpus'
import type { PrismaClient } from '../generated/prisma'

function makeSelfReplyRow(overrides: {
  id: string
  accountId: string
  inReplyToTweetId: string | null
}) {
  return {
    id: overrides.id,
    accountId: overrides.accountId,
    inReplyToTweetId: overrides.inReplyToTweetId,
    fullText: 'これマジで見て',
    expandedUrls: ['https://x.com/other_creator/status/999'],
    createdAt: new Date('2026-01-01T00:00:00Z'),
  }
}

describe('loadSelfReplyPromoCorpus', () => {
  it("queries self-authored replies and resolves the un-corpus'd root ancestor for each chain", async () => {
    // alice の自己返信チェーン: root1(非対象) <- reply1 <- reply2
    const tweetFindMany = vi
      .fn()
      .mockResolvedValueOnce([
        makeSelfReplyRow({ id: 'reply2', accountId: 'alice1', inReplyToTweetId: 'reply1' }),
        makeSelfReplyRow({ id: 'reply1', accountId: 'alice1', inReplyToTweetId: 'root1' }),
      ])
      .mockResolvedValueOnce([
        { id: 'root1', accountId: 'alice1', isReply: false, isRetweet: false },
      ])
    const accountFindMany = vi.fn().mockResolvedValue([{ id: 'alice1', screenName: 'alice' }])
    const prisma = {
      tweet: { findMany: tweetFindMany },
      account: { findMany: accountFindMany },
    } as unknown as PrismaClient

    const result = await loadSelfReplyPromoCorpus(prisma, new Date('2026-01-02T00:00:00Z'))

    expect(result.selfReplyCorpus).toHaveLength(2)
    expect(result.selfReplyCorpus[0].authorScreenName).toBe('alice')
    expect(result.rootCorpus).toEqual([
      { id: 'root1', accountId: 'alice1', isReply: false, isRetweet: false },
    ])
    // 投稿者は重複を除いて 1 回の問い合わせで引く。
    expect(accountFindMany).toHaveBeenCalledTimes(1)
    expect(accountFindMany).toHaveBeenCalledWith({
      where: { id: { in: ['alice1'] } },
      select: { id: true, screenName: true },
    })
    // root 解決クエリは self-reply corpus に含まれない親 id のみを対象にする。
    expect(tweetFindMany).toHaveBeenCalledTimes(2)
    const rootQueryArgs = tweetFindMany.mock.calls[1][0] as { where: { id: { in: string[] } } }
    expect(rootQueryArgs.where.id.in).toEqual(['root1'])
  })

  it('drops self-replies whose author has no Account row', async () => {
    const tweetFindMany = vi
      .fn()
      .mockResolvedValueOnce([
        makeSelfReplyRow({ id: 'reply1', accountId: 'alice1', inReplyToTweetId: null }),
        makeSelfReplyRow({ id: 'reply2', accountId: 'ghost1', inReplyToTweetId: null }),
      ])
    const accountFindMany = vi.fn().mockResolvedValue([{ id: 'alice1', screenName: 'alice' }])
    const prisma = {
      tweet: { findMany: tweetFindMany },
      account: { findMany: accountFindMany },
    } as unknown as PrismaClient

    const result = await loadSelfReplyPromoCorpus(prisma, new Date())

    expect(result.selfReplyCorpus.map((entry) => entry.id)).toEqual(['reply1'])
  })

  it('skips the account and root queries entirely when there are no self-replies', async () => {
    const tweetFindMany = vi.fn().mockResolvedValueOnce([])
    const accountFindMany = vi.fn()
    const prisma = {
      tweet: { findMany: tweetFindMany },
      account: { findMany: accountFindMany },
    } as unknown as PrismaClient

    const result = await loadSelfReplyPromoCorpus(prisma, new Date())

    expect(result.selfReplyCorpus).toEqual([])
    expect(result.rootCorpus).toEqual([])
    expect(tweetFindMany).toHaveBeenCalledTimes(1)
    expect(accountFindMany).not.toHaveBeenCalled()
  })
})
