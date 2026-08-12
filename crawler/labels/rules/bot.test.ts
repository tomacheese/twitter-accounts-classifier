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

function makeVelocityBundle(options: { replyRatioOverride: number }): AccountFeatureBundle {
  const oneYearAgo = new Date('2025-01-01T00:00:00Z')
  const sampleSize = 1000
  const replyCount = Math.round(sampleSize * options.replyRatioOverride)
  const tweets = regularTweets(sampleSize, 60e3).map((tweet, i) => ({
    ...tweet,
    isReply: i < replyCount,
  }))
  return makeBundle({ tweetCount: 100_000, accountCreatedAt: oneYearAgo }, tweets)
}

describe('botRule', () => {
  it('is true for a high-velocity account with regular intervals and no replies', () => {
    const oneYearAgo = new Date('2025-01-01T00:00:00Z')
    const result = botRule.evaluate(
      makeBundle({ tweetCount: 100_000, accountCreatedAt: oneYearAgo }, regularTweets(10, 60e3)),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0)
  })

  it('is false for a heavy but human-plausible posting rate', () => {
    const nineteenYearsAgo = new Date('2007-04-03T00:00:00Z')
    const result = botRule.evaluate(
      makeBundle(
        { tweetCount: 301_205, accountCreatedAt: nineteenYearsAgo },
        regularTweets(10, 3.6e6),
      ),
    )
    expect(result.value).toBe(false)
  })

  it('is false for an old, large account whose lifetime tweetCount is inflated but recent posting cadence is normal (e.g. a decade-old verified brand account)', () => {
    const tenYearsAgo = new Date('2016-01-01T00:00:00Z')
    const base = new Date('2026-01-01T00:00:00Z').getTime()
    const dayMs = 24 * 60 * 60 * 1000
    // 生涯平均の tweetCount は水増しされているが、
    // 直近のサンプルはまばらな投稿間隔であり、通常の投稿頻度を示す。
    const sparseTweets: AccountFeatureBundle['recentTweets'] = Array.from(
      { length: 14 },
      (_, i) => ({
        id: `t${i}`,
        fullText: 'brand announcement',
        createdAt: new Date(base + i * 1.5 * dayMs),
        retweetCount: 0,
        likeCount: 0,
        isReply: false,
        isRetweet: false,
        isPromoted: false,
        isPaidPromotion: false,
      }),
    )
    const result = botRule.evaluate(
      makeBundle({ tweetCount: 37_461_200, accountCreatedAt: tenYearsAgo }, sparseTweets),
    )
    expect(result.value).toBe(false)
  })

  it('is false for high velocity when reply ratio is meaningful and intervals are irregular', () => {
    const oneYearAgo = new Date('2025-01-01T00:00:00Z')
    const base = new Date('2026-01-01T00:00:00Z').getTime()
    const tweets: AccountFeatureBundle['recentTweets'] = [
      {
        id: 't0',
        fullText: 'a',
        createdAt: new Date(base),
        retweetCount: 0,
        likeCount: 0,
        isReply: true,
        isRetweet: false,
        isPromoted: false,
        isPaidPromotion: false,
      },
      {
        id: 't1',
        fullText: 'b',
        createdAt: new Date(base + 90e3),
        retweetCount: 0,
        likeCount: 0,
        isReply: false,
        isRetweet: false,
        isPromoted: false,
        isPaidPromotion: false,
      },
      {
        id: 't2',
        fullText: 'c',
        createdAt: new Date(base + 500e3),
        retweetCount: 0,
        likeCount: 0,
        isReply: true,
        isRetweet: false,
        isPromoted: false,
        isPaidPromotion: false,
      },
      {
        id: 't3',
        fullText: 'd',
        createdAt: new Date(base + 510e3),
        retweetCount: 0,
        likeCount: 0,
        isReply: false,
        isRetweet: false,
        isPromoted: false,
        isPaidPromotion: false,
      },
      {
        id: 't4',
        fullText: 'e',
        createdAt: new Date(base + 900e3),
        retweetCount: 0,
        likeCount: 0,
        isReply: true,
        isRetweet: false,
        isPromoted: false,
        isPaidPromotion: false,
      },
    ]
    const result = botRule.evaluate(
      makeBundle({ tweetCount: 100_000, accountCreatedAt: oneYearAgo }, tweets),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a short live-tweeting burst from an account with an otherwise ordinary lifetime posting rate', () => {
    const threeYearsAgo = new Date('2023-01-01T00:00:00Z')
    const result = botRule.evaluate(
      makeBundle(
        // 生涯平均の投稿頻度は閾値を大きく下回っている。
        { tweetCount: 6000, accountCreatedAt: threeYearsAgo },
        // 短時間に集中した投稿バーストであり、生涯にわたる bot 的な挙動の根拠にはならない。
        regularTweets(20, (44 * 60_000) / 19),
      ),
    )
    expect(result.value).toBe(false)
  })

  it('is false for a prolific human retweeter whose few original posts are conversational', () => {
    const twelveYearsAgo = new Date('2014-01-01T00:00:00Z')
    const base = new Date('2026-01-01T00:00:00Z').getTime()
    // 不規則な間隔でサンプルしたツイートのうち大半がリツイートで、
    // オリジナル投稿はわずかであり、その一部が返信である。
    const irregularOffsetsMs = [
      0, 40e3, 950e3, 1010e3, 1100e3, 3400e3, 3450e3, 3500e3, 8000e3, 8100e3, 12_000e3, 12_400e3,
      12_500e3, 20_000e3, 20_100e3, 27_000e3, 27_500e3, 33_000e3, 40_000e3, 41_000e3,
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

  it('is false for a high-velocity, never-reply account whose posting intervals are irregular (e.g. an official brand/media account on a content calendar)', () => {
    const oneYearAgo = new Date('2025-01-01T00:00:00Z')
    const base = new Date('2026-01-01T00:00:00Z').getTime()
    const irregularOffsetsMs = [0, 30e3, 60e3, 90e3, 5000e3, 5030e3, 5060e3, 9000e3, 9030e3, 9060e3]
    const tweets: AccountFeatureBundle['recentTweets'] = irregularOffsetsMs.map((offset, i) => ({
      id: `t${i}`,
      fullText: 'announcement',
      createdAt: new Date(base + offset),
      retweetCount: 0,
      likeCount: 0,
      isReply: false,
      isRetweet: false,
      isPromoted: false,
      isPaidPromotion: false,
    }))
    const result = botRule.evaluate(
      makeBundle({ tweetCount: 200_000, accountCreatedAt: oneYearAgo }, tweets),
    )
    expect(result.value).toBe(false)
  })

  it('lowers confidence when replyRatio only marginally clears the threshold, even if other signals are strong', () => {
    const strong = makeVelocityBundle({ replyRatioOverride: 0 })
    const marginal = makeVelocityBundle({ replyRatioOverride: 0.049 })
    const strongResult = botRule.evaluate(strong)
    const marginalResult = botRule.evaluate(marginal)
    expect(strongResult.value).toBe(true)
    expect(marginalResult.value).toBe(true)
    expect(marginalResult.confidence).toBeLessThan(strongResult.confidence)
  })
})
