import { describe, expect, it } from 'vitest'
import type { AccountFeatureBundle } from '../types'
import { amazonAffiliateLinkRule } from './amazon-affiliate-link'

function makeBundle(recentTweets: AccountFeatureBundle['recentTweets']): AccountFeatureBundle {
  return {
    account: {
      id: 'fictional-account',
      screenName: 'fictional',
      displayName: 'Fictional',
      bio: null,
      followersCount: 0,
      followingCount: 0,
      tweetCount: recentTweets.length,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
      isBlueVerified: false,
      verifiedType: null,
    },
    recentTweets,
  }
}

function tweet(
  overrides: Partial<AccountFeatureBundle['recentTweets'][number]> = {},
): AccountFeatureBundle['recentTweets'][number] {
  return {
    id: 't1',
    fullText: 'おすすめの商品です',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    retweetCount: 0,
    likeCount: 0,
    isReply: false,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
    expandedUrls: [],
    ...overrides,
  }
}

describe('amazonAffiliateLinkRule', () => {
  it('is true for an original tweet with an Amazon Associates tag', () => {
    const result = amazonAffiliateLinkRule.evaluate(
      makeBundle([
        tweet({ expandedUrls: ['https://www.amazon.co.jp/dp/FICTIONAL?tag=fictional-22'] }),
      ]),
    )
    expect(result.value).toBe(true)
    expect(result.reason).toContain('associate-tag')
  })

  it('is true for an original tweet with an amzn.to Associates short link', () => {
    expect(
      amazonAffiliateLinkRule.evaluate(
        makeBundle([tweet({ expandedUrls: ['https://amzn.to/fictional'] })]),
      ).value,
    ).toBe(true)
  })

  it('is false for a plain Amazon product URL, with high confidence since no affiliate evidence was found', () => {
    const result = amazonAffiliateLinkRule.evaluate(
      makeBundle([tweet({ expandedUrls: ['https://www.amazon.co.jp/dp/FICTIONAL'] })]),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(1)
  })

  it('is false when the affiliate link occurs only in a retweet', () => {
    expect(
      amazonAffiliateLinkRule.evaluate(
        makeBundle([
          tweet({
            isRetweet: true,
            expandedUrls: ['https://www.amazon.co.jp/dp/FICTIONAL?tag=fictional-22'],
          }),
        ]),
      ).value,
    ).toBe(false)
  })

  it('recentTweets が未取得 (null) の場合、false のまま evaluable: false になる', () => {
    const bundle = makeBundle([])
    bundle.account.recentTweetsFetchStatus = null
    const result = amazonAffiliateLinkRule.evaluate(bundle)
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })
})
