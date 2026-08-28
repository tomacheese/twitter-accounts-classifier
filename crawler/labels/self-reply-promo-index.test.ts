import { describe, expect, it } from 'vitest'
import { buildSelfReplyPromoIndex } from './self-reply-promo-index'
import type { SelfReplyPromoCorpusEntry, RootCandidateEntry } from '../db/self-reply-promo-corpus'

function selfReply(overrides: {
  id: string
  accountId: string
  inReplyToTweetId: string
  expandedUrls?: string[]
  fullText?: string
  authorScreenName?: string
}): SelfReplyPromoCorpusEntry {
  return {
    id: overrides.id,
    accountId: overrides.accountId,
    inReplyToTweetId: overrides.inReplyToTweetId,
    fullText: overrides.fullText ?? 'これマジで見て',
    expandedUrls: overrides.expandedUrls ?? ['https://x.com/other_creator/status/999'],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    authorScreenName: overrides.authorScreenName ?? 'alice',
  }
}

function qualifyingRoot(id: string, accountId: string): RootCandidateEntry {
  return { id, accountId, isReply: false, isRetweet: false }
}

describe('buildSelfReplyPromoIndex', () => {
  it('counts distinct roots that reuse the same destination status as exactDestinationRoots', () => {
    const roots = [
      qualifyingRoot('root1', 'alice1'),
      qualifyingRoot('root2', 'alice1'),
      qualifyingRoot('root3', 'alice1'),
    ]
    const corpus = [
      selfReply({ id: 'r1', accountId: 'alice1', inReplyToTweetId: 'root1' }),
      selfReply({ id: 'r2', accountId: 'alice1', inReplyToTweetId: 'root2' }),
      selfReply({ id: 'r3', accountId: 'alice1', inReplyToTweetId: 'root3' }),
    ]

    const index = buildSelfReplyPromoIndex(corpus, roots)
    const evidence = index.evidenceFor('alice1')

    expect(evidence?.exactDestinationRoots).toBe(3)
    expect(evidence?.promoRoots).toBe(3)
  })

  it('counts repeated depth>=2 campaigns as multiHopRoots even when the destination status differs', () => {
    const roots = [
      qualifyingRoot('root1', 'alice1'),
      qualifyingRoot('root2', 'alice1'),
      qualifyingRoot('root3', 'alice1'),
    ]
    // 各 root から 2 hop 目でランダムに変わる status id へ誘導するが、文面・誘導先ハンドルは共通させる。
    const corpus = [
      selfReply({ id: 'r1a', accountId: 'alice1', inReplyToTweetId: 'root1', expandedUrls: [] }),
      selfReply({
        id: 'r1b',
        accountId: 'alice1',
        inReplyToTweetId: 'r1a',
        expandedUrls: ['https://x.com/promo_target/status/101'],
        fullText: '見て損はないよ↓',
      }),
      selfReply({ id: 'r2a', accountId: 'alice1', inReplyToTweetId: 'root2', expandedUrls: [] }),
      selfReply({
        id: 'r2b',
        accountId: 'alice1',
        inReplyToTweetId: 'r2a',
        expandedUrls: ['https://x.com/promo_target/status/202'],
        fullText: '見て損はないよ↓',
      }),
      selfReply({ id: 'r3a', accountId: 'alice1', inReplyToTweetId: 'root3', expandedUrls: [] }),
      selfReply({
        id: 'r3b',
        accountId: 'alice1',
        inReplyToTweetId: 'r3a',
        expandedUrls: ['https://x.com/promo_target/status/303'],
        fullText: '見て損はないよ↓',
      }),
    ]

    const index = buildSelfReplyPromoIndex(corpus, roots)
    const evidence = index.evidenceFor('alice1')

    expect(evidence?.multiHopRoots).toBe(3)
    expect(evidence?.maxChainDepth).toBe(2)
  })

  it('excludes a link to the account own X status', () => {
    const roots = [qualifyingRoot('root1', 'alice1')]
    const corpus = [
      selfReply({
        id: 'r1',
        accountId: 'alice1',
        inReplyToTweetId: 'root1',
        expandedUrls: ['https://x.com/alice/status/555'],
        authorScreenName: 'alice',
      }),
    ]

    const index = buildSelfReplyPromoIndex(corpus, roots)

    expect(index.evidenceFor('alice1')).toBeUndefined()
  })

  it('excludes a chain whose root is itself a reply (not a standalone post)', () => {
    const roots = [{ id: 'root1', accountId: 'alice1', isReply: true, isRetweet: false }]
    const corpus = [
      selfReply({ id: 'r1', accountId: 'alice1', inReplyToTweetId: 'root1' }),
      selfReply({ id: 'r2', accountId: 'alice1', inReplyToTweetId: 'root1' }),
      selfReply({ id: 'r3', accountId: 'alice1', inReplyToTweetId: 'root1' }),
    ]

    const index = buildSelfReplyPromoIndex(corpus, roots)

    expect(index.evidenceFor('alice1')).toBeUndefined()
  })

  it('returns undefined for an account with no qualifying edges', () => {
    const index = buildSelfReplyPromoIndex([], [])
    expect(index.evidenceFor('alice1')).toBeUndefined()
  })
})
