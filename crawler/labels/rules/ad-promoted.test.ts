import { describe, expect, it } from 'vitest'
import { adPromotedRule } from './ad-promoted'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  recentTweets: AccountFeatureBundle['recentTweets'],
  accountOverrides: Partial<AccountFeatureBundle['account']> = {},
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

function tweet(
  overrides: Partial<AccountFeatureBundle['recentTweets'][number]>,
): AccountFeatureBundle['recentTweets'][number] {
  return {
    id: 't1',
    fullText: 'hello',
    createdAt: new Date(),
    retweetCount: 0,
    likeCount: 0,
    isReply: false,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
    ...overrides,
  }
}

const daysAgo = (days: number, offsetMs = 0) =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000 + offsetMs)

describe('adPromotedRule', () => {
  it('is true when at least one recent tweet is marked isPromoted', () => {
    const result = adPromotedRule.evaluate(
      makeBundle([tweet({}), tweet({ id: 't2', isPromoted: true })]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })

  it('is false when no recent tweet is promoted, with high confidence since no evidence was found', () => {
    const result = adPromotedRule.evaluate(makeBundle([tweet({}), tweet({ id: 't2' })]))
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(1)
  })

  it('is false for an account with no recent tweets', () => {
    const result = adPromotedRule.evaluate(makeBundle([]))
    expect(result.value).toBe(false)
  })

  it('is false with neutral evaluable=false when recentTweets were never fetched, instead of a confident false', () => {
    const result = adPromotedRule.evaluate(makeBundle([], { recentTweetsFetchStatus: null }))
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBe(0.5)
  })

  describe('period-based recent window', () => {
    it('is true for a promoted tweet inside the window even when many newer tweets exist', () => {
      const newer = Array.from({ length: 30 }, (_, i) =>
        tweet({ id: `n${i}`, createdAt: daysAgo(1) }),
      )
      const result = adPromotedRule.evaluate(
        makeBundle([...newer, tweet({ id: 'p', isPromoted: true, createdAt: daysAgo(29) })]),
      )
      expect(result.value).toBe(true)
    })

    it('is false for a promoted tweet older than the window', () => {
      const result = adPromotedRule.evaluate(
        makeBundle([tweet({ id: 'p', isPromoted: true, createdAt: daysAgo(91) })]),
      )
      expect(result.value).toBe(false)
    })

    it('includes the 90-day boundary and excludes just beyond it', () => {
      expect(
        adPromotedRule.evaluate(
          makeBundle([tweet({ isPromoted: true, createdAt: daysAgo(90, 60_000) })]),
        ).value,
      ).toBe(true)
      expect(
        adPromotedRule.evaluate(
          makeBundle([tweet({ isPromoted: true, createdAt: daysAgo(90, -60_000) })]),
        ).value,
      ).toBe(false)
    })

    it('is true when only the DB count in the window is positive, beyond the loaded tweets', () => {
      const bundle = makeBundle([tweet({ createdAt: daysAgo(1) })])
      bundle.promotedTweetCountInWindow = 1
      const result = adPromotedRule.evaluate(bundle)
      expect(result.value).toBe(true)
      expect(result.reason).toContain('promotedTweetCountInWindow=1')
    })

    it('is false when the DB count is 0 and recent tweets have no promotion', () => {
      const bundle = makeBundle([tweet({ createdAt: daysAgo(1) })])
      bundle.promotedTweetCountInWindow = 0
      expect(adPromotedRule.evaluate(bundle).value).toBe(false)
    })

    it('falls back to recentTweets only when the DB count is undefined', () => {
      const bundle = makeBundle([tweet({ isPromoted: true, createdAt: daysAgo(1) })])
      expect(bundle.promotedTweetCountInWindow).toBeUndefined()
      expect(adPromotedRule.evaluate(bundle).value).toBe(true)
    })
  })
})
