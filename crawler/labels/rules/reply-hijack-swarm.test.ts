import { describe, expect, it } from 'vitest'
import { replyHijackSwarmRule } from './reply-hijack-swarm'
import type { AccountFeatureBundle } from '../types'

function tweet(isReply: boolean, isRetweet = false): AccountFeatureBundle['recentTweets'][number] {
  return {
    id: Math.random().toString(),
    fullText: 'x',
    createdAt: new Date(),
    retweetCount: 0,
    likeCount: 0,
    isReply,
    isRetweet,
    isPromoted: false,
    isPaidPromotion: false,
  }
}

function replyOnlyTweets(count: number): AccountFeatureBundle['recentTweets'] {
  return Array.from({ length: count }, () => tweet(true))
}

function makeBundle(
  replyHijackSwarmSize: number | undefined,
  recentTweets: AccountFeatureBundle['recentTweets'] = replyOnlyTweets(5),
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
    },
    recentTweets,
    replyHijackSwarmSize,
  }
}

describe('replyHijackSwarmRule', () => {
  it('is true when the account is part of a 5+ member swarm and looks reply-only', () => {
    const result = replyHijackSwarmRule.evaluate(makeBundle(5))

    expect(result.value).toBe(true)
    expect(result.confidence).toBeGreaterThan(0)
  })

  it('is true with higher confidence for a larger swarm', () => {
    const small = replyHijackSwarmRule.evaluate(makeBundle(5))
    const large = replyHijackSwarmRule.evaluate(makeBundle(15))

    expect(large.confidence).toBeGreaterThan(small.confidence)
  })

  it('is false just below the 5-member boundary', () => {
    const result = replyHijackSwarmRule.evaluate(makeBundle(4))

    expect(result.value).toBe(false)
  })

  it('is false when replyHijackSwarmSize is absent', () => {
    const result = replyHijackSwarmRule.evaluate(makeBundle(undefined))

    expect(result.value).toBe(false)
    expect(result.confidence).toBe(0)
  })

  it('is false for a 5+ member swarm when the account also posts plenty of original content', () => {
    const original = [tweet(false), tweet(false), tweet(false), tweet(false), tweet(true)]
    const result = replyHijackSwarmRule.evaluate(makeBundle(10, original))

    expect(result.value).toBe(false)
  })

  it('is false for a 5+ member swarm when the account mostly retweets rather than replies (genuine retweet-consumer, not a reply-hijacker)', () => {
    const mostlyRetweets = [
      tweet(false, true),
      tweet(false, true),
      tweet(false, true),
      tweet(false, true),
      tweet(true),
    ]
    const result = replyHijackSwarmRule.evaluate(makeBundle(10, mostlyRetweets))

    expect(result.value).toBe(false)
  })

  it('is false for a 5+ member swarm when there are too few sampled tweets to corroborate reply-focus', () => {
    const result = replyHijackSwarmRule.evaluate(makeBundle(10, replyOnlyTweets(2)))

    expect(result.value).toBe(false)
  })

  it('reports replyRatio and sample size in the reason string', () => {
    const result = replyHijackSwarmRule.evaluate(makeBundle(5))

    expect(result.reason).toMatch(/replyRatio=1\.00 \(n=5\)/)
  })
})
