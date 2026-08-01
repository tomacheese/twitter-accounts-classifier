import { describe, expect, it } from 'vitest'
import { videoRepostRule } from './video-repost'
import type { AccountFeatureBundle } from '../types'

function makeBundle(recentTweets: AccountFeatureBundle['recentTweets']): AccountFeatureBundle {
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
  it('is false when there are no quoted-video candidates', () => {
    const result = videoRepostRule.evaluate(makeBundle([tweet({ quotedTweetAuthorId: null })]))
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0)
  })

  it('is false when candidates are below the minimum sample size', () => {
    const result = videoRepostRule.evaluate(makeBundle([tweet({ id: 't1' }), tweet({ id: 't2' })]))
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0)
  })

  it('is true when there are enough quoted-video candidates', () => {
    const result = videoRepostRule.evaluate(
      makeBundle([tweet({ id: 't1' }), tweet({ id: 't2' }), tweet({ id: 't3' })]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })

  it('excludes tweets quoting the account own video from candidates', () => {
    const result = videoRepostRule.evaluate(
      makeBundle([
        tweet({ id: 't1', quotedTweetAuthorId: 'alice' }),
        tweet({ id: 't2', quotedTweetAuthorId: 'alice' }),
        tweet({ id: 't3', quotedTweetAuthorId: 'alice' }),
      ]),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0)
  })

  it('excludes tweets whose quoted content has no video (photo-only, or unevaluated)', () => {
    const result = videoRepostRule.evaluate(
      makeBundle([
        tweet({ id: 't1', quotedTweetHasVideo: false }),
        tweet({ id: 't2', quotedTweetHasVideo: null }),
        tweet({ id: 't3', quotedTweetHasVideo: undefined }),
      ]),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0)
  })
})
