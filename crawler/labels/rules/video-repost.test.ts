import { describe, expect, it } from 'vitest'
import { videoRepostRule } from './video-repost'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  recentTweets: AccountFeatureBundle['recentTweets'],
  accountOverrides: Partial<AccountFeatureBundle['account']> = {},
): AccountFeatureBundle {
  return {
    account: {
      id: 'alice',
      screenName: 'alice',
      displayName: 'Alice',
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
    fullText: 'look at this',
    createdAt: new Date(),
    retweetCount: 0,
    likeCount: 0,
    isReply: false,
    isRetweet: false,
    isPromoted: false,
    isPaidPromotion: false,
    quotedTweetAuthorId: 'bob',
    quotedTweetHasVideo: true,
    ...overrides,
  }
}

describe('videoRepostRule', () => {
  it('is false when there are no source-attributed videos, with high confidence since no evidence was found', () => {
    const result = videoRepostRule.evaluate(makeBundle([tweet({ quotedTweetAuthorId: null })]))
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(1)
    expect(result.reason).toBe('foreignVideoPostCount=0 (n=1)')
  })

  it('does not treat repeated quote-posts of another account video as reuse', () => {
    const result = videoRepostRule.evaluate(
      makeBundle([tweet({ id: 't1' }), tweet({ id: 't2' }), tweet({ id: 't3' })]),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(1)
    expect(result.reason).toBe('foreignVideoPostCount=0 (n=3)')
  })

  it('is true when X reports three direct videos from other source accounts', () => {
    const result = videoRepostRule.evaluate(
      makeBundle([
        tweet({ id: 't1', foreignVideoSourceCount: 1 }),
        tweet({ id: 't2', foreignVideoSourceCount: 1 }),
        tweet({ id: 't3', foreignVideoSourceCount: 1 }),
      ]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
    expect(result.reason).toBe('foreignVideoPostCount=3 (n=3)')
  })

  it('excludes native retweets even when they carry source metadata', () => {
    const result = videoRepostRule.evaluate(
      makeBundle([
        tweet({ id: 't1', isRetweet: true, foreignVideoSourceCount: 1 }),
        tweet({ id: 't2', isRetweet: true, foreignVideoSourceCount: 1 }),
        tweet({ id: 't3', isRetweet: true, foreignVideoSourceCount: 1 }),
      ]),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(1)
    expect(result.reason).toBe('foreignVideoPostCount=0 (n=3)')
  })

  it('is false with neutral evaluable=false when recentTweets were never fetched, instead of a confident false', () => {
    const result = videoRepostRule.evaluate(makeBundle([], { recentTweetsFetchStatus: null }))
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBe(0.5)
  })
})
