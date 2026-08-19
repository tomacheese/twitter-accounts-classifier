import { describe, expect, it } from 'vitest'
import type { AccountFeatureBundle } from '../types'
import { bareLinkSpamRule } from './bare-link-spam'

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
    fullText: 'お得な情報はこちら',
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

function bareLinkTweet(id: string): AccountFeatureBundle['recentTweets'][number] {
  return tweet({
    id,
    fullText: 'https://t.co/exampleXXXX',
    expandedUrls: ['https://example.test/x'],
  })
}

function captionedLinkTweet(id: string): AccountFeatureBundle['recentTweets'][number] {
  return tweet({
    id,
    fullText: '今日はいい天気でした https://t.co/exampleXXXX',
    expandedUrls: ['https://example.test/x'],
  })
}

describe('bareLinkSpamRule', () => {
  it('is true when most of own posts are bare links (no caption) regardless of domain', () => {
    const result = bareLinkSpamRule.evaluate(
      makeBundle([
        bareLinkTweet('t1'),
        bareLinkTweet('t2'),
        bareLinkTweet('t3'),
        bareLinkTweet('t4'),
        captionedLinkTweet('t5'),
      ]),
    )
    expect(result.value).toBe(true)
  })

  it('is false when most of own posts have a caption alongside the link', () => {
    const result = bareLinkSpamRule.evaluate(
      makeBundle([
        captionedLinkTweet('t1'),
        captionedLinkTweet('t2'),
        captionedLinkTweet('t3'),
        captionedLinkTweet('t4'),
        bareLinkTweet('t5'),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it('is false for an empty tweet with no URL at all (not a link post)', () => {
    const result = bareLinkSpamRule.evaluate(
      makeBundle([
        tweet({ id: 't1', fullText: '', expandedUrls: [] }),
        tweet({ id: 't2', fullText: '', expandedUrls: [] }),
        tweet({ id: 't3', fullText: '', expandedUrls: [] }),
        tweet({ id: 't4', fullText: '', expandedUrls: [] }),
        tweet({ id: 't5', fullText: '', expandedUrls: [] }),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it('does not count retweets or replies toward own posts', () => {
    const result = bareLinkSpamRule.evaluate(
      makeBundle([
        bareLinkTweet('t1'),
        tweet({ id: 't2', isRetweet: true, fullText: 'https://t.co/exampleXXXX' }),
        tweet({ id: 't3', isReply: true, fullText: 'https://t.co/exampleXXXX' }),
      ]),
    )
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.reason).toContain('n=1/1')
  })

  it('is false with neutral evaluable=false when there are fewer than the minimum sample size', () => {
    const result = bareLinkSpamRule.evaluate(makeBundle([bareLinkTweet('t1'), bareLinkTweet('t2')]))
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })

  it('recentTweets が未取得 (null) の場合、false のまま evaluable: false になる', () => {
    const result = bareLinkSpamRule.evaluate(makeBundle([], { recentTweetsFetchStatus: null }))
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBeCloseTo(0.5)
  })
})
