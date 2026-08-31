import { describe, expect, it } from 'vitest'
import type { AccountFeatureBundle } from '../types'
import { amazonAffiliatePrSpamRule } from './amazon-affiliate-pr-spam'

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
    fullText: 'こんにちは',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    retweetCount: 0,
    likeCount: 0,
    isReply: false,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
    expandedUrls: [],
    cardDestinationUrls: [],
    cardDestinationUrlsEvaluated: true,
    ...overrides,
  }
}

function matchedTweet(id: string): AccountFeatureBundle['recentTweets'][number] {
  return tweet({
    id,
    fullText: `新商品を使ってみました！ #PR ${id}`,
    expandedUrls: [`https://www.amazon.co.jp/dp/FICTIONAL${id}?tag=fictional-22`],
  })
}

describe('amazonAffiliatePrSpamRule stale-scan safety', () => {
  it('is excluded from scanForStaleAccounts so adding this rule does not stale-flag every existing account', () => {
    expect(amazonAffiliatePrSpamRule.excludeFromStaleScan).toBe(true)
  })
})

describe('amazonAffiliatePrSpamRule', () => {
  it('is true when every own post (20/20) matches PR + Amazon affiliate evidence', () => {
    const tweets = Array.from({ length: 20 }, (_, i) => matchedTweet(`m${i}`))
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(true)
    expect(result.reason).toBe(
      'prEvidence=20/20, affiliateEvidence=20/20, cardAffiliateEvidence=0/20, matched=20/20 (ratio=1.00), coverage=1.00 (n=20)',
    )
  })

  it('is true exactly at the boundary (6/8 matched, coverage=1.0)', () => {
    const tweets = [
      ...Array.from({ length: 6 }, (_, i) => matchedTweet(`m${i}`)),
      tweet({ id: 'n1', fullText: '今日はいい天気ですね' }),
      tweet({ id: 'n2', fullText: 'お昼ご飯なに食べようかな' }),
    ]
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(true)
  })

  it('is false just below the boundary (5/8 matched)', () => {
    const tweets = [
      ...Array.from({ length: 5 }, (_, i) => matchedTweet(`m${i}`)),
      tweet({ id: 'n1', fullText: '今日はいい天気ですね' }),
      tweet({ id: 'n2', fullText: 'お昼ご飯なに食べようかな' }),
      tweet({ id: 'n3', fullText: 'お天気の話' }),
    ]
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it('is false when posts disclose PR but never link an Amazon affiliate URL', () => {
    const tweets = Array.from({ length: 8 }, (_, i) =>
      tweet({ id: `pr${i}`, fullText: `新商品を使ってみました！ #PR ${i}` }),
    )
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it('is false when posts link an Amazon affiliate URL but never disclose PR', () => {
    const tweets = Array.from({ length: 8 }, (_, i) =>
      tweet({
        id: `link${i}`,
        fullText: `おすすめの商品です ${i}`,
        expandedUrls: [`https://www.amazon.co.jp/dp/FICTIONAL${i}?tag=fictional-22`],
      }),
    )
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it('is non-evaluable, not a confident negative, for a single matched post below the minimum sample size', () => {
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle([matchedTweet('m0')]))
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBe(0.5)
  })

  it('is non-evaluable when Card evaluation coverage is below the threshold', () => {
    const tweets = [
      ...Array.from({ length: 6 }, (_, i) => matchedTweet(`m${i}`)),
      tweet({ id: 'u1', fullText: '未評価1', cardDestinationUrlsEvaluated: false }),
      tweet({ id: 'u2', fullText: '未評価2', cardDestinationUrlsEvaluated: false }),
      tweet({ id: 'u3', fullText: '未評価3', cardDestinationUrlsEvaluated: false }),
      tweet({ id: 'u4', fullText: '未評価4', cardDestinationUrlsEvaluated: false }),
    ]
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
  })

  it('excludes retweets and replies from own posts', () => {
    const tweets = [
      matchedTweet('m0'),
      tweet({ id: 'rt1', isRetweet: true, fullText: 'RT @brand: #PR', expandedUrls: [] }),
      tweet({ id: 'rp1', isReply: true, fullText: 'こちらこそ #PR', expandedUrls: [] }),
    ]
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
  })

  it('accepts isPaidPromotion as PR evidence without a #PR hashtag', () => {
    const tweets = [
      ...Array.from({ length: 6 }, (_, i) =>
        tweet({
          id: `pp${i}`,
          fullText: `新商品を使ってみました！ ${i}`,
          isPaidPromotion: true,
          expandedUrls: [`https://www.amazon.co.jp/dp/FICTIONAL${i}?tag=fictional-22`],
        }),
      ),
      tweet({ id: 'n1', fullText: '今日はいい天気ですね' }),
      tweet({ id: 'n2', fullText: 'お昼ご飯なに食べようかな' }),
    ]
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(true)
  })

  it('does not treat a plain untagged Amazon URL as affiliate evidence', () => {
    const tweets = Array.from({ length: 8 }, (_, i) =>
      tweet({
        id: `plain${i}`,
        fullText: `新商品を使ってみました！ #PR ${i}`,
        expandedUrls: [`https://www.amazon.co.jp/dp/FICTIONAL${i}`],
      }),
    )
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(false)
  })

  it('treats an amzn.to short link as high-confidence affiliate evidence', () => {
    const tweets = Array.from({ length: 8 }, (_, i) =>
      tweet({
        id: `short${i}`,
        fullText: `新商品を使ってみました！ #PR ${i}`,
        expandedUrls: [`https://amzn.to/fictional${i}`],
      }),
    )
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(true)
  })

  it('finds Card destination URL evidence even when expandedUrls carries none', () => {
    const tweets = [
      ...Array.from({ length: 6 }, (_, i) =>
        tweet({
          id: `card${i}`,
          fullText: `新商品を使ってみました！ #PR ${i}`,
          expandedUrls: [],
          cardDestinationUrls: [`https://www.amazon.co.jp/dp/FICTIONAL${i}?tag=fictional-22`],
        }),
      ),
      tweet({ id: 'n1', fullText: '今日はいい天気ですね' }),
      tweet({ id: 'n2', fullText: 'お昼ご飯なに食べようかな' }),
    ]
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.value).toBe(true)
    expect(result.reason).toBe(
      'prEvidence=6/8, affiliateEvidence=6/8, cardAffiliateEvidence=6/8, matched=6/8 (ratio=0.75), coverage=1.00 (n=8)',
    )
  })

  it('records auditable counts for PR evidence, Amazon affiliate evidence, Card-based Amazon affiliate evidence, matched ratio/count, and Card evaluation coverage in reason', () => {
    const tweets = [
      // expandedUrls 経由で一致 (3件)
      ...Array.from({ length: 3 }, (_, i) => matchedTweet(`expanded${i}`)),
      // cardDestinationUrls 経由でのみ一致 (2件)
      ...Array.from({ length: 2 }, (_, i) =>
        tweet({
          id: `card${i}`,
          fullText: `新商品を使ってみました！ #PR ${i}`,
          expandedUrls: [],
          cardDestinationUrls: [`https://www.amazon.co.jp/dp/FICTIONAL${i}?tag=fictional-22`],
        }),
      ),
      // PR 開示のみで Amazon アソシエイトリンクなし
      tweet({ id: 'pr-only', fullText: '新商品を使ってみました！ #PR' }),
      // Amazon アソシエイトリンクのみで PR 開示なし
      tweet({
        id: 'affiliate-only',
        fullText: 'おすすめの商品です',
        expandedUrls: ['https://www.amazon.co.jp/dp/FICTIONALX?tag=fictional-22'],
      }),
      // Card 未評価 (assessable から除外される)
      tweet({ id: 'unevaluated', fullText: '未評価', cardDestinationUrlsEvaluated: false }),
      // PR 開示・Amazon アソシエイトリンクいずれもなし
      tweet({ id: 'neutral1', fullText: '今日はいい天気ですね' }),
      tweet({ id: 'neutral2', fullText: 'お昼ご飯なに食べようかな' }),
    ]
    const result = amazonAffiliatePrSpamRule.evaluate(makeBundle(tweets))
    expect(result.reason).toBe(
      'prEvidence=6/10, affiliateEvidence=6/10, cardAffiliateEvidence=2/10, matched=5/9 (ratio=0.56), coverage=0.90 (n=10)',
    )
  })

  it('recentTweets が未取得 (null) の場合、false のまま evaluable: false になる', () => {
    const result = amazonAffiliatePrSpamRule.evaluate(
      makeBundle([], { recentTweetsFetchStatus: null }),
    )
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBe(0.5)
  })
})
