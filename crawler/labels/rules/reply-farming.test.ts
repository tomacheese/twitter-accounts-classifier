import { describe, expect, it } from 'vitest'
import { replyFarmingRule } from './reply-farming'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  tweetsPerDay: number,
  tweets: { isReply?: boolean; isRetweet?: boolean }[],
): AccountFeatureBundle {
  const ageDays = 100
  return {
    account: {
      id: '1',
      screenName: 'x',
      displayName: 'X',
      bio: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: Math.round(tweetsPerDay * ageDays),
      accountCreatedAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000),
      isBlueVerified: false,
      verifiedType: null,
    },
    recentTweets: tweets.map((t, i) => ({
      id: `t${i}`,
      fullText: `tweet ${i}`,
      createdAt: new Date(),
      retweetCount: 0,
      likeCount: 0,
      isReply: t.isReply ?? false,
      isRetweet: t.isRetweet ?? false,
      isPromoted: false,
      isPaidPromotion: false,
    })),
  }
}

describe('replyFarmingRule', () => {
  it('is true for a high-velocity account whose recent tweets are all replies/retweets', () => {
    const bundle = makeBundle(340, [
      { isReply: true },
      { isReply: true },
      { isReply: true },
      { isRetweet: true },
      { isReply: true },
      { isReply: true },
    ])

    const result = replyFarmingRule.evaluate(bundle)

    expect(result.value).toBe(true)
  })

  it('is false for a high-velocity account that still posts original content', () => {
    const bundle = makeBundle(340, [
      { isReply: true },
      { isReply: true },
      {},
      {},
      { isReply: true },
      {},
    ])

    const result = replyFarmingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false for a low-velocity account even with zero original content', () => {
    const bundle = makeBundle(1, [
      { isReply: true },
      { isReply: true },
      { isReply: true },
      { isReply: true },
      { isReply: true },
    ])

    const result = replyFarmingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false when the recent-tweet sample is too small to judge', () => {
    const bundle = makeBundle(340, [{ isReply: true }, { isReply: true }])

    const result = replyFarmingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false for an old, large account whose lifetime tweetCount is inflated but the sampled replies were posted at a normal cadence (e.g. a decade-old verified brand account)', () => {
    const dayMs = 24 * 60 * 60 * 1000
    const base = new Date('2026-01-01T00:00:00Z').getTime()
    const bundle: AccountFeatureBundle = {
      account: {
        id: '1',
        screenName: 'x',
        displayName: 'X',
        bio: null,
        followersCount: 0,
        followingCount: 0,
        tweetCount: 37_461_200,
        accountCreatedAt: new Date('2016-01-01T00:00:00Z'),
        isBlueVerified: false,
        verifiedType: null,
      },
      recentTweets: Array.from({ length: 6 }, (_, i) => ({
        id: `t${i}`,
        fullText: `reply ${i}`,
        createdAt: new Date(base + i * 1.5 * dayMs),
        retweetCount: 0,
        likeCount: 0,
        isReply: true,
        isRetweet: false,
        isPromoted: false,
        isPaidPromotion: false,
      })),
    }

    const result = replyFarmingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false for a high-velocity pure retweeter that posts no replies at all', () => {
    const bundle = makeBundle(
      340,
      Array.from({ length: 20 }, () => ({ isRetweet: true })),
    )

    const result = replyFarmingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false for a high-velocity account that mostly retweets and only occasionally replies', () => {
    const bundle = makeBundle(340, [
      ...Array.from({ length: 18 }, () => ({ isRetweet: true })),
      { isReply: true },
      { isReply: true },
    ])

    const result = replyFarmingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })

  it('is false for a short reply burst from an account with an otherwise ordinary lifetime posting rate', () => {
    const bundle = makeBundle(
      5.5, // 生涯平均の投稿頻度は閾値を大きく下回っている
      Array.from({ length: 20 }, () => ({ isReply: true })),
    )

    const result = replyFarmingRule.evaluate(bundle)

    expect(result.value).toBe(false)
  })
})
