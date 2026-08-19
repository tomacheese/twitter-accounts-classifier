import { describe, expect, it } from 'vitest'
import type { AccountFeatureBundle } from '../types'
import { amazonAffiliatePromotedRule } from './amazon-affiliate-promoted'

function makeBundle(
  recentTweets: AccountFeatureBundle['recentTweets'],
  accountOverrides: Partial<AccountFeatureBundle['account']> = {},
): AccountFeatureBundle {
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
      ...accountOverrides,
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

describe('amazonAffiliatePromotedRule', () => {
  it('is true when the same original tweet is promoted and contains an Associates link', () => {
    const result = amazonAffiliatePromotedRule.evaluate(
      makeBundle([
        tweet({
          fullText: '便利でした (pr)',
          isPromoted: true,
          isPaidPromotion: true,
          expandedUrls: ['https://www.amazon.co.jp/dp/FICTIONAL?tag=fictional-22'],
        }),
      ]),
    )
    expect(result.value).toBe(true)
    expect(result.reason).toContain('tweet=t1')
    expect(result.reason).toContain('paidPromotion=true')
  })

  it('is false when an Associates link is not promoted, with high confidence since no matching evidence was found', () => {
    const result = amazonAffiliatePromotedRule.evaluate(
      makeBundle([
        tweet({ expandedUrls: ['https://www.amazon.co.jp/dp/FICTIONAL?tag=fictional-22'] }),
      ]),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(1)
  })

  it('is false when a promoted tweet only has a plain Amazon URL', () => {
    expect(
      amazonAffiliatePromotedRule.evaluate(
        makeBundle([
          tweet({ isPromoted: true, expandedUrls: ['https://www.amazon.co.jp/dp/FICTIONAL'] }),
        ]),
      ).value,
    ).toBe(false)
  })

  it('is false when affiliate evidence and promotion occur on different tweets', () => {
    expect(
      amazonAffiliatePromotedRule.evaluate(
        makeBundle([
          tweet({
            id: 'affiliate',
            expandedUrls: ['https://www.amazon.co.jp/dp/FICTIONAL?tag=fictional-22'],
          }),
          tweet({ id: 'promoted', isPromoted: true }),
        ]),
      ).value,
    ).toBe(false)
  })

  it('is false when the matching promoted affiliate post is a retweet', () => {
    expect(
      amazonAffiliatePromotedRule.evaluate(
        makeBundle([
          tweet({
            isRetweet: true,
            isPromoted: true,
            expandedUrls: ['https://amzn.to/fictional'],
          }),
        ]),
      ).value,
    ).toBe(false)
  })

  it('does not use isPaidPromotion alone as proof of boosting', () => {
    expect(
      amazonAffiliatePromotedRule.evaluate(
        makeBundle([
          tweet({
            isPaidPromotion: true,
            expandedUrls: ['https://www.amazon.co.jp/dp/FICTIONAL?tag=fictional-22'],
          }),
        ]),
      ).value,
    ).toBe(false)
  })

  it('recentTweets が未取得 (null) の場合、false のまま evaluable: false になる', () => {
    const result = amazonAffiliatePromotedRule.evaluate(
      makeBundle([], { recentTweetsFetchStatus: null }),
    )
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })
})
