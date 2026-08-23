import { describe, expect, it } from 'vitest'
import { tweetAiGeneratedMediaRule } from './tweet-ai-generated-media'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  recentTweets: AccountFeatureBundle['recentTweets'],
  recentTweetsFetchStatus?: AccountFeatureBundle['account']['recentTweetsFetchStatus'],
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
      ...(recentTweetsFetchStatus !== undefined ? { recentTweetsFetchStatus } : {}),
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

describe('tweetAiGeneratedMediaRule', () => {
  it('is false when no recent tweet has AI-generated media', () => {
    const result = tweetAiGeneratedMediaRule.evaluate(makeBundle([tweet({}), tweet({ id: 't2' })]))
    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0)
  })

  it('is false for an account with no recent tweets', () => {
    const result = tweetAiGeneratedMediaRule.evaluate(makeBundle([]))
    expect(result.value).toBe(false)
  })

  it('is evaluable=false when recentTweets was never fetched', () => {
    const result = tweetAiGeneratedMediaRule.evaluate(makeBundle([], null))
    expect(result).toMatchObject({ value: false, confidence: 0.5, evaluable: false })
  })

  it('is evaluable=false when recentTweets fetch failed', () => {
    const result = tweetAiGeneratedMediaRule.evaluate(makeBundle([], 'failed'))
    expect(result).toMatchObject({ value: false, confidence: 0.5, evaluable: false })
  })

  it('is an evaluable negative when recentTweets fetch succeeded with no tweets', () => {
    const result = tweetAiGeneratedMediaRule.evaluate(makeBundle([], 'success'))
    expect(result).toMatchObject({ value: false, confidence: 0 })
    expect(result.evaluable).not.toBe(false)
  })

  it('is true with high confidence when the detection source is C2paClient', () => {
    const result = tweetAiGeneratedMediaRule.evaluate(
      makeBundle([tweet({ hasAiGeneratedMedia: true, aiGeneratedDetectionSource: 'C2paClient' })]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })

  it('is true with slightly lower confidence when the detection source is UserDeclared', () => {
    const result = tweetAiGeneratedMediaRule.evaluate(
      makeBundle([
        tweet({ hasAiGeneratedMedia: true, aiGeneratedDetectionSource: 'UserDeclared' }),
      ]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(0.9)
  })

  it('is true with moderate confidence when the detection source is platform-detected', () => {
    const result = tweetAiGeneratedMediaRule.evaluate(
      makeBundle([
        tweet({
          hasAiGeneratedMedia: true,
          aiGeneratedDetectionSource: 'ContentDisclosureAiGeneratedDisclosure',
        }),
      ]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(0.75)
  })

  it('is true with a conservative fallback confidence when the source is unknown', () => {
    const result = tweetAiGeneratedMediaRule.evaluate(
      makeBundle([tweet({ hasAiGeneratedMedia: true, aiGeneratedDetectionSource: null })]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(0.6)
  })

  it('uses the highest confidence across multiple flagged tweets', () => {
    const result = tweetAiGeneratedMediaRule.evaluate(
      makeBundle([
        tweet({
          id: 't1',
          hasAiGeneratedMedia: true,
          aiGeneratedDetectionSource: 'ContentDisclosureAiGeneratedDisclosure',
        }),
        tweet({ id: 't2', hasAiGeneratedMedia: true, aiGeneratedDetectionSource: 'C2paClient' }),
      ]),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })
})
