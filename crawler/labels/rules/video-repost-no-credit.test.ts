import { describe, expect, it } from 'vitest'
import { videoRepostNoCreditRule } from './video-repost-no-credit'
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

describe('videoRepostNoCreditRule', () => {
  it('is false when there are no quoted-video candidates', () => {
    const result = videoRepostNoCreditRule.evaluate(
      makeBundle([tweet({ quotedTweetAuthorId: null })]),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0)
  })

  it('is false when candidates are below the minimum sample size, even if all uncredited', () => {
    const result = videoRepostNoCreditRule.evaluate(
      makeBundle([tweet({ id: 't1' }), tweet({ id: 't2' })]),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0)
  })

  it('is false when there are enough candidates but all are credited', () => {
    const result = videoRepostNoCreditRule.evaluate(
      makeBundle([
        tweet({ id: 't1', fullText: 'nice clip, credit: bob' }),
        tweet({ id: 't2', fullText: 'via @bob_example' }),
        tweet({ id: 't3', fullText: '出典: bob' }),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it('is true when the uncredited ratio is exactly at the threshold', () => {
    const result = videoRepostNoCreditRule.evaluate(
      makeBundle([
        tweet({ id: 't1', fullText: 'no credit here' }),
        tweet({ id: 't2', fullText: 'no credit here either' }),
        tweet({ id: 't3', fullText: 'credit: bob' }),
        tweet({ id: 't4', fullText: 'credit: bob' }),
      ]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(0.5)
  })

  it('is false when the uncredited ratio is below the threshold', () => {
    const result = videoRepostNoCreditRule.evaluate(
      makeBundle([
        tweet({ id: 't1', fullText: 'no credit here' }),
        tweet({ id: 't2', fullText: 'credit: bob' }),
        tweet({ id: 't3', fullText: 'credit: bob' }),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it('excludes tweets quoting the account own video from candidates', () => {
    const result = videoRepostNoCreditRule.evaluate(
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
    const result = videoRepostNoCreditRule.evaluate(
      makeBundle([
        tweet({ id: 't1', quotedTweetHasVideo: false }),
        tweet({ id: 't2', quotedTweetHasVideo: null }),
        tweet({ id: 't3', quotedTweetHasVideo: undefined }),
      ]),
    )
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0)
  })

  it('matches both English (via @) and Japanese (出典:) credit expressions', () => {
    const result = videoRepostNoCreditRule.evaluate(
      makeBundle([
        tweet({ id: 't1', fullText: 'cool clip via @bob_example' }),
        tweet({ id: 't2', fullText: '出典: bob_example' }),
        tweet({ id: 't3', fullText: 'no attribution at all' }),
      ]),
    )
    expect(result.value).toBe(false)
  })

  it('does not match "credit" as part of an unrelated word like "credits"', () => {
    const result = videoRepostNoCreditRule.evaluate(
      makeBundle([
        tweet({ id: 't1', fullText: 'rolling credits at the end of the video' }),
        tweet({ id: 't2', fullText: 'no attribution here' }),
        tweet({ id: 't3', fullText: 'still no attribution' }),
      ]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBeCloseTo(1)
  })

  it('does not match "credit" as the tail of an unrelated word like "discredit"', () => {
    const result = videoRepostNoCreditRule.evaluate(
      makeBundle([
        tweet({ id: 't1', fullText: 'this clip seems to discredit: the original claim' }),
        tweet({ id: 't2', fullText: 'no attribution here' }),
        tweet({ id: 't3', fullText: 'still no attribution' }),
      ]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBeCloseTo(1)
  })

  it('matches "credit" followed by a full-width colon', () => {
    const result = videoRepostNoCreditRule.evaluate(
      makeBundle([
        tweet({ id: 't1', fullText: 'credit：bob' }),
        tweet({ id: 't2', fullText: 'credit：bob' }),
        tweet({ id: 't3', fullText: 'credit：bob' }),
      ]),
    )
    expect(result.value).toBe(false)
  })
})
