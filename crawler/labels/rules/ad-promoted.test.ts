import { describe, expect, it } from 'vitest'
import { adPromotedRule } from './ad-promoted'
import type { AccountFeatureBundle } from '../types'

function makeBundle(recentTweets: AccountFeatureBundle['recentTweets']): AccountFeatureBundle {
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
})
