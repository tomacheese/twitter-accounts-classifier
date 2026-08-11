import { describe, expect, it } from 'vitest'
import { crossTargetTemplatedReplyRule } from './cross-target-templated-reply'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  tweets: {
    fullText: string
    isReply?: boolean
    isRetweet?: boolean
    hoursAgo?: number
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
      createdAt: new Date(Date.now() - (t.hoursAgo ?? 0) * 60 * 60 * 1000),
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
        isReply: false,
        isRetweet: true,
        hoursAgo: i,
        inReplyToTweetId: `target${i}`,
      })),
    )

    const result = crossTargetTemplatedReplyRule.evaluate(bundle)

    expect(result.value).toBe(false)
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
})
