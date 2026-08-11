import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { crossTargetTemplatedReplyRule } from './cross-target-templated-reply'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  tweets: {
    fullText: string
    isReply?: boolean
    isRetweet?: boolean
    hoursAgo?: number
    createdAt?: Date
    inReplyToTweetId?: string | null
  }[],
): AccountFeatureBundle {
  return {
    account: {
      id: '1',
      screenName: 'x',
      displayName: 'X',
      bio: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date(),
      isBlueVerified: false,
      verifiedType: null,
    },
    recentTweets: tweets.map((t, i) => ({
      id: `t${i}`,
      fullText: t.fullText,
      createdAt: t.createdAt ?? new Date(Date.now() - (t.hoursAgo ?? 0) * 60 * 60 * 1000),
      retweetCount: 0,
      likeCount: 0,
      isReply: t.isReply ?? false,
      isRetweet: t.isRetweet ?? false,
      isPromoted: false,
      isPaidPromotion: false,
      inReplyToTweetId: t.inReplyToTweetId === undefined ? null : t.inReplyToTweetId,
    })),
  }
}

const TEMPLATE_TEXT =
  'このアカウントは素晴らしい発信をされていて、いつも参考にさせていただいております'

describe('crossTargetTemplatedReplyRule', () => {
  it('is true when the same templated reply hits 5 distinct targets within 24 hours', () => {
    const bundle = makeBundle(
      Array.from({ length: 5 }, (_, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        hoursAgo: i,
        inReplyToTweetId: `target${i}`,
      })),
    )

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(true)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('is false when distinct targets are 4 or fewer', () => {
    const bundle = makeBundle(
      Array.from({ length: 4 }, (_, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        hoursAgo: i,
        inReplyToTweetId: `target${i}`,
      })),
    )

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false when 5 or more replies all target the same single tweet', () => {
    const bundle = makeBundle(
      Array.from({ length: 5 }, (_, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        hoursAgo: i,
        inReplyToTweetId: 'same-target',
      })),
    )

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false when the same text is spread across distinct targets over more than 24 hours', () => {
    const bundle = makeBundle(
      Array.from({ length: 5 }, (_, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        hoursAgo: i * 10,
        inReplyToTweetId: `target${i}`,
      })),
    )

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('treats replies differing only in URL or mention as the same template', () => {
    const bundle = makeBundle(
      Array.from({ length: 5 }, (_, i) => ({
        fullText: `@target${i} ${TEMPLATE_TEXT} https://example.com/status/${i}`,
        isReply: true,
        hoursAgo: i,
        inReplyToTweetId: `target${i}`,
      })),
    )

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(true)
  })

  it('excludes greetings shorter than the normalized-length floor', () => {
    const bundle = makeBundle(
      Array.from({ length: 5 }, (_, i) => ({
        fullText: 'いいね！',
        isReply: true,
        hoursAgo: i,
        inReplyToTweetId: `target${i}`,
      })),
    )

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('does not count replies with an unknown parent tweet as a distinct target', () => {
    const bundle = makeBundle([
      ...Array.from({ length: 5 }, (_, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        hoursAgo: i,
        inReplyToTweetId: null,
      })),
      { fullText: TEMPLATE_TEXT, isReply: true, hoursAgo: 5, inReplyToTweetId: 'target-known' },
    ])

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('ignores retweets when grouping by template text', () => {
    const bundle = makeBundle(
      Array.from({ length: 5 }, (_, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        isRetweet: true,
        hoursAgo: i,
        inReplyToTweetId: `target${i}`,
      })),
    )

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it("does not count replies to the account's own past tweets as distinct targets", () => {
    const bundle = makeBundle([
      ...Array.from({ length: 5 }, (_, i) => ({
        fullText: `own post ${i}`,
        isReply: false,
        hoursAgo: 10 + i,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        hoursAgo: i,
        inReplyToTweetId: `t${i}`,
      })),
    ])

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('includes a reply landing exactly 24 hours after the window anchor', () => {
    const anchor = new Date('2024-01-01T00:00:00.000Z').getTime()
    const bundle = makeBundle(
      [0, 6, 12, 18, 24].map((hoursAfterAnchor, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        createdAt: new Date(anchor + hoursAfterAnchor * 60 * 60 * 1000),
        inReplyToTweetId: `target${i}`,
      })),
    )

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(true)
  })

  it('reaches full confidence at 10 or more distinct targets', () => {
    const bundle = makeBundle(
      Array.from({ length: 10 }, (_, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        hoursAgo: i,
        inReplyToTweetId: `target${i}`,
      })),
    )

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })

  it('is true for a recent 12-hour cluster of 5 distinct targets even with an unrelated 2-day-old reply mixed in', () => {
    const bundle = makeBundle([
      { fullText: TEMPLATE_TEXT, isReply: true, hoursAgo: 48, inReplyToTweetId: 'target-old' },
      ...Array.from({ length: 5 }, (_, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        hoursAgo: i * 3,
        inReplyToTweetId: `target${i}`,
      })),
    ])

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(true)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('deterministically picks the lexicographically smaller template text when two groups tie on stats, regardless of tweet insertion order', () => {
    const clusterA = Array.from({ length: 5 }, (_, i) => ({
      fullText: 'aaaa この文面はテスト用の完全に架空のリプライテンプレートです',
      isReply: true,
      hoursAgo: i,
      inReplyToTweetId: `target-a${i}`,
    }))
    const clusterZ = Array.from({ length: 5 }, (_, i) => ({
      fullText: 'zzzz この文面はテスト用の完全に架空のリプライテンプレートです',
      isReply: true,
      hoursAgo: i,
      inReplyToTweetId: `target-z${i}`,
    }))

    const resultAFirst = crossTargetTemplatedReplyRule.evaluate(
      makeBundle([...clusterA, ...clusterZ]),
    )
    const resultZFirst = crossTargetTemplatedReplyRule.evaluate(
      makeBundle([...clusterZ, ...clusterA]),
    )

    expect(resultAFirst.reason).toEqual(resultZFirst.reason)
    const expectedHash = createHash('sha256')
      .update('aaaa この文面はテスト用の完全に架空のリプライテンプレートです')
      .digest('hex')
      .slice(0, 16)
    expect(resultAFirst.reason).toContain(`textHash=${expectedHash}`)
  })

  it('deterministically breaks a within-group window tie by preferring the higher reply count', () => {
    const bundle = makeBundle([
      ...Array.from({ length: 5 }, (_, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        hoursAgo: 40 + i,
        inReplyToTweetId: `old-target${i}`,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        fullText: TEMPLATE_TEXT,
        isReply: true,
        hoursAgo: i,
        inReplyToTweetId: `new-target${i}`,
      })),
      { fullText: TEMPLATE_TEXT, isReply: true, hoursAgo: 0.5, inReplyToTweetId: 'new-target4' },
    ])

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(true)
    expect(result.reason).toContain('replies=6')
    expect(result.reason).toContain('spanHours=4.0')
  })
})
