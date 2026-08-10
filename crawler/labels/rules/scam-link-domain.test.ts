import { describe, expect, it } from 'vitest'
import type { AccountFeatureBundle } from '../types'
import { scamLinkDomainRule } from './scam-link-domain'

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

describe('scamLinkDomainRule', () => {
  it('is true for an original tweet with an exact indicator hostname match', () => {
    const result = scamLinkDomainRule.evaluate(
      makeBundle([tweet({ expandedUrls: ['https://1link.jp/fictional'] })]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
    expect(result.reason).toContain('host=1link.jp')
  })

  it('is true for a subdomain of an indicator hostname', () => {
    expect(
      scamLinkDomainRule.evaluate(
        makeBundle([tweet({ expandedUrls: ['https://foo.1link.jp/fictional'] })]),
      ).value,
    ).toBe(true)
  })

  it('is false when only a lookalike domain is present', () => {
    expect(
      scamLinkDomainRule.evaluate(
        makeBundle([tweet({ expandedUrls: ['https://evil1link.jp/fictional'] })]),
      ).value,
    ).toBe(false)
  })

  it('is true when only one of several URLs matches', () => {
    expect(
      scamLinkDomainRule.evaluate(
        makeBundle([
          tweet({
            expandedUrls: ['https://example.com/fictional', 'https://1link.jp/fictional'],
          }),
        ]),
      ).value,
    ).toBe(true)
  })

  it('is false when the matching URL occurs only in a retweet', () => {
    expect(
      scamLinkDomainRule.evaluate(
        makeBundle([tweet({ isRetweet: true, expandedUrls: ['https://1link.jp/fictional'] })]),
      ).value,
    ).toBe(false)
  })

  it('is true when the matching URL occurs in a reply', () => {
    expect(
      scamLinkDomainRule.evaluate(
        makeBundle([tweet({ isReply: true, expandedUrls: ['https://1link.jp/fictional'] })]),
      ).value,
    ).toBe(true)
  })

  it('does not fail evaluation when a malformed URL is mixed in', () => {
    const result = scamLinkDomainRule.evaluate(
      makeBundle([tweet({ expandedUrls: ['not a url', 'https://1link.jp/fictional'] })]),
    )
    expect(result.value).toBe(true)
  })

  it('is false when expandedUrls is empty', () => {
    expect(scamLinkDomainRule.evaluate(makeBundle([tweet({ expandedUrls: [] })])).value).toBe(false)
  })

  it('is false when expandedUrls is undefined', () => {
    const bundle = makeBundle([tweet()])
    delete bundle.recentTweets[0].expandedUrls
    expect(scamLinkDomainRule.evaluate(bundle).value).toBe(false)
  })
})
