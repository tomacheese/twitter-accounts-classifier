import { describe, expect, it, vi } from 'vitest'
import { loadSelfReplyPromoCorpus } from './self-reply-promo-corpus'
import type { PrismaClient } from '../generated/prisma'

function makeSelfReplyRow(overrides: {
  id: string
  accountId: string
  inReplyToTweetId: string | null
  authorScreenName?: string
}) {
  return {
    id: overrides.id,
    accountId: overrides.accountId,
    inReplyToTweetId: overrides.inReplyToTweetId,
    fullText: 'これマジで見て',
    expandedUrls: ['https://x.com/other_creator/status/999'],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    account: { screenName: overrides.authorScreenName ?? 'alice' },
  }
}

describe('loadSelfReplyPromoCorpus', () => {
  it("queries self-authored replies and resolves the un-corpus'd root ancestor for each chain", async () => {
    // alice の自己返信チェーン: root1(非対象) <- reply1 <- reply2
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([
        makeSelfReplyRow({ id: 'reply2', accountId: 'alice1', inReplyToTweetId: 'reply1' }),
        makeSelfReplyRow({ id: 'reply1', accountId: 'alice1', inReplyToTweetId: 'root1' }),
      ])
      .mockResolvedValueOnce([
        { id: 'root1', accountId: 'alice1', isReply: false, isRetweet: false },
      ])
    const prisma = { tweet: { findMany } } as unknown as PrismaClient

    const result = await loadSelfReplyPromoCorpus(prisma, new Date('2026-01-02T00:00:00Z'))

    expect(result.selfReplyCorpus).toHaveLength(2)
    expect(result.selfReplyCorpus[0].authorScreenName).toBe('alice')
    expect(result.rootCorpus).toEqual([
      { id: 'root1', accountId: 'alice1', isReply: false, isRetweet: false },
    ])
    // root 解決クエリは self-reply corpus に含まれない親 id のみを対象にする。
    expect(findMany).toHaveBeenCalledTimes(2)
    const rootQueryArgs = findMany.mock.calls[1][0] as { where: { id: { in: string[] } } }
    expect(rootQueryArgs.where.id.in).toEqual(['root1'])
  })

  it('skips the root query entirely when there are no self-replies', async () => {
    const findMany = vi.fn().mockResolvedValueOnce([])
    const prisma = { tweet: { findMany } } as unknown as PrismaClient

    const result = await loadSelfReplyPromoCorpus(prisma, new Date())

    expect(result.selfReplyCorpus).toEqual([])
    expect(result.rootCorpus).toEqual([])
    expect(findMany).toHaveBeenCalledTimes(1)
  })
})
