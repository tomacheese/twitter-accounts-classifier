import { describe, expect, it } from 'vitest'
import { replyFarmingRule } from './reply-farming'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  tweetsPerDay: number,
  tweets: { isReply?: boolean; isRetweet?: boolean; ownConversation?: boolean }[],
  spanHours = 6,
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
      // 直近頻度の観測期間下限 (6 時間) ちょうどに均等配置する。
      createdAt: new Date(
        Date.now() - (tweets.length > 1 ? (i / (tweets.length - 1)) * spanHours * 3_600_000 : 0),
      ),
      retweetCount: 0,
      likeCount: 0,
      isReply: t.isReply ?? false,
      isRetweet: t.isRetweet ?? false,
      isPromoted: false,
      isPaidPromotion: false,
      conversationRootAuthorId: t.ownConversation === true ? '1' : null,
    })),
  }
}

describe('replyFarmingRule', () => {
  it('is true for a high-velocity account whose recent tweets are all replies/retweets', () => {
    const bundle = makeBundle(340, [
      ...Array.from({ length: 19 }, () => ({ isReply: true })),
      { isRetweet: true },
    ])

    const result = replyFarmingRule.evaluate(bundle)

    expect(result.value).toBe(true)
  })

  it('is false for a high-velocity account that still posts original content', () => {
    const bundle = makeBundle(340, [
      ...Array.from({ length: 10 }, () => ({ isReply: true })),
      ...Array.from({ length: 10 }, () => ({})),
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

  it('marks an undersized sample as not evaluable with neutral confidence', () => {
    const result = replyFarmingRule.evaluate(
      makeBundle(340, [{ isReply: true }, { isReply: true }]),
    )

    expect(result).toMatchObject({ value: false, evaluable: false, confidence: 0.5 })
  })

  it('distinguishes a strong velocity negative from a near-threshold negative', () => {
    const stronglyNegative = replyFarmingRule.evaluate(
      makeBundle(
        1,
        Array.from({ length: 6 }, () => ({ isReply: true })),
      ),
    )
    const nearMiss = replyFarmingRule.evaluate(
      makeBundle(
        149,
        Array.from({ length: 6 }, () => ({ isReply: true })),
      ),
    )

    expect(stronglyNegative.value).toBe(false)
    expect(nearMiss.value).toBe(false)
    expect(stronglyNegative.confidence).toBeGreaterThan(nearMiss.confidence)
  })

  it('lowers positive confidence when a required signal is only just above its threshold', () => {
    const result = replyFarmingRule.evaluate(
      makeBundle(
        151,
        Array.from({ length: 20 }, () => ({ isReply: true })),
      ),
    )

    expect(result.value).toBe(true)
    expect(result.confidence).toBeLessThan(1)
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

  it('is false when most replies are inside conversations rooted at the account itself', () => {
    const bundle = makeBundle(340, [
      ...Array.from({ length: 14 }, () => ({ isReply: true, ownConversation: true })),
      ...Array.from({ length: 6 }, () => ({ isReply: true })),
    ])

    expect(replyFarmingRule.evaluate(bundle).value).toBe(false)
  })

  it('does not extrapolate a daily rate from a burst shorter than the observation floor', () => {
    const burst = Array.from({ length: 10 }, () => ({ isReply: true }))
    const sustained = Array.from({ length: 20 }, () => ({ isReply: true }))

    expect(replyFarmingRule.evaluate(makeBundle(340, burst, 0)).value).toBe(false)
    expect(replyFarmingRule.evaluate(makeBundle(340, burst, 6)).value).toBe(false)
    expect(replyFarmingRule.evaluate(makeBundle(340, sustained, 6)).value).toBe(true)
  })

  it('is evaluable with a confident false when the lifetime velocity alone rules the account out', () => {
    const result = replyFarmingRule.evaluate(makeBundle(5, [{ isReply: true }]))

    expect(result).toMatchObject({ value: false, evaluable: true })
  })

  it('stays not evaluable for a small sample when the lifetime velocity is high', () => {
    const result = replyFarmingRule.evaluate(makeBundle(340, [{ isReply: true }]))

    expect(result).toMatchObject({ value: false, evaluable: false })
  })
})
