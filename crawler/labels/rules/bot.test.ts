import { describe, expect, it } from 'vitest'
import { botRule } from './bot'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  accountOverrides: Partial<AccountFeatureBundle['account']>,
  recentTweets: AccountFeatureBundle['recentTweets'] = [],
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
      ...accountOverrides,
    },
    recentTweets,
  }
}

function regularTweets(count: number, intervalMs: number): AccountFeatureBundle['recentTweets'] {
  const base = new Date('2026-01-01T00:00:00Z').getTime()
  return Array.from({ length: count }, (_, i) => ({
    id: `t${i}`,
    fullText: 'scheduled post',
    createdAt: new Date(base + i * intervalMs),
    retweetCount: 0,
    likeCount: 0,
    isReply: false,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
  }))
}

describe('botRule', () => {
  it('is true for a high-velocity account with regular intervals and no replies', () => {
    const oneYearAgo = new Date('2025-01-01T00:00:00Z')
    const result = botRule.evaluate(
      makeBundle(
        { tweetCount: 100_000, accountCreatedAt: oneYearAgo },
        regularTweets(10, 60e3),
      ),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0)
  })

  it('is false for a heavy but human-plausible posting rate', () => {
    const nineteenYearsAgo = new Date('2007-04-03T00:00:00Z')
    const result = botRule.evaluate(
      makeBundle({ tweetCount: 301_205, accountCreatedAt: nineteenYearsAgo }, regularTweets(10, 3.6e6)),
    )
    expect(result.value).toBe(false)
  })

  it('is false for an old, large account whose lifetime tweetCount is inflated but recent posting cadence is normal (e.g. a decade-old verified brand account)', () => {
    const tenYearsAgo = new Date('2016-01-01T00:00:00Z')
    const base = new Date('2026-01-01T00:00:00Z').getTime()
    const dayMs = 24 * 60 * 60 * 1000
    // 14 tweets spread across ~19 days, i.e. under one tweet a day - not the wildly
    // inflated lifetime average (tweetCount / accountAge) that on its own would clear the
    // velocity threshold.
    const sparseTweets: AccountFeatureBundle['recentTweets'] = Array.from({ length: 14 }, (_, i) => ({
      id: `t${i}`,
      fullText: 'brand announcement',
      createdAt: new Date(base + i * 1.5 * dayMs),
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
    }))
    const result = botRule.evaluate(
      makeBundle({ tweetCount: 37_461_200, accountCreatedAt: tenYearsAgo }, sparseTweets),
    )
    expect(result.value).toBe(false)
  })

  it('is false for high velocity when reply ratio is meaningful and intervals are irregular', () => {
    const oneYearAgo = new Date('2025-01-01T00:00:00Z')
    const base = new Date('2026-01-01T00:00:00Z').getTime()
    const tweets: AccountFeatureBundle['recentTweets'] = [
      { id: 't0', fullText: 'a', createdAt: new Date(base), retweetCount: 0, likeCount: 0, isReply: true, isRetweet: false, isPromoted: false, isPaidPromotion: false },
      { id: 't1', fullText: 'b', createdAt: new Date(base + 90e3), retweetCount: 0, likeCount: 0, isReply: false, isRetweet: false, isPromoted: false, isPaidPromotion: false },
      { id: 't2', fullText: 'c', createdAt: new Date(base + 500e3), retweetCount: 0, likeCount: 0, isReply: true, isRetweet: false, isPromoted: false, isPaidPromotion: false },
      { id: 't3', fullText: 'd', createdAt: new Date(base + 510e3), retweetCount: 0, likeCount: 0, isReply: false, isRetweet: false, isPromoted: false, isPaidPromotion: false },
      { id: 't4', fullText: 'e', createdAt: new Date(base + 900e3), retweetCount: 0, likeCount: 0, isReply: true, isRetweet: false, isPromoted: false, isPaidPromotion: false },
    ]
    const result = botRule.evaluate(makeBundle({ tweetCount: 100_000, accountCreatedAt: oneYearAgo }, tweets))
    expect(result.value).toBe(false)
  })

  it('is false for a short live-tweeting burst from an account with an otherwise ordinary lifetime posting rate', () => {
    const threeYearsAgo = new Date('2023-01-01T00:00:00Z')
    const result = botRule.evaluate(
      makeBundle(
        // ~5.5 tweets/day lifetime average, far below the 150/day threshold.
        { tweetCount: 6000, accountCreatedAt: threeYearsAgo },
        // 20 tweets within 44 minutes - a real burst, but not evidence of bot-like
        // lifetime behavior.
        regularTweets(20, (44 * 60_000) / 19),
      ),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a prolific human retweeter whose few original posts are conversational', () => {
    const twelveYearsAgo = new Date('2014-01-01T00:00:00Z')
    const base = new Date('2026-01-01T00:00:00Z').getTime()
    // 20 sampled tweets at irregular intervals: 17 retweets plus 3 original posts, one of
    // which is a reply. Over all 20 the reply ratio reads 0.05; over the 3 original posts
    // it reads 0.33 - and 3 originals is below the minimum sample for the signal anyway.
    const irregularOffsetsMs = [
      0, 40e3, 950e3, 1010e3, 1100e3, 3400e3, 3450e3, 3500e3, 8000e3, 8100e3,
      12_000e3, 12_400e3, 12_500e3, 20_000e3, 20_100e3, 27_000e3, 27_500e3, 33_000e3,
      40_000e3, 41_000e3,
    ]
    const tweets: AccountFeatureBundle['recentTweets'] = irregularOffsetsMs.map((offset, i) => ({
      id: `t${i}`,
      fullText: i < 17 ? 'RT @someone: 応援してます' : '今日も推しが尊い',
      createdAt: new Date(base + offset),
      retweetCount: 0,
      likeCount: 0,
      isReply: i === 19,
      isRetweet: i < 17,
      isPromoted: false,
      isPaidPromotion: false,
    }))
    const result = botRule.evaluate(
      makeBundle({ tweetCount: 900_000, accountCreatedAt: twelveYearsAgo }, tweets),
    )
    expect(result.value).toBe(false)
  })

  it('is still true for a high-velocity account posting only original, non-conversational content', () => {
    const oneYearAgo = new Date('2025-01-01T00:00:00Z')
    const result = botRule.evaluate(
      makeBundle({ tweetCount: 100_000, accountCreatedAt: oneYearAgo }, regularTweets(10, 60e3)),
    )
    expect(result.value).toBe(true)
  })
})
