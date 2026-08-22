import { describe, expect, it } from 'vitest'
import { templatedReplyNetworkRule } from './templated-reply-network'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  templatedReplyNetworkSize: number | undefined,
  accountOverrides: Partial<AccountFeatureBundle['account']> = {},
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
      ...accountOverrides,
    },
    recentTweets: [],
    templatedReplyNetworkSize,
  }
}

describe('templatedReplyNetworkRule', () => {
  it('is true when at least 5 other accounts share the same templated reply text', () => {
    const result = templatedReplyNetworkRule.evaluate(makeBundle(5))
    expect(result.value).toBe(true)
  })

  it('is false when fewer than 5 other accounts share the reply text', () => {
    const result = templatedReplyNetworkRule.evaluate(makeBundle(4))
    expect(result.value).toBe(false)
  })

  it('is false when the bundle does not populate templatedReplyNetworkSize', () => {
    const result = templatedReplyNetworkRule.evaluate(makeBundle(undefined))
    expect(result.value).toBe(false)
  })

  it('caps confidence at 1 for very large networks', () => {
    const result = templatedReplyNetworkRule.evaluate(makeBundle(100))
    expect(result.confidence).toBe(1)
  })

  it('is false with neutral evaluable=false when recentTweets were never fetched, instead of a confident false', () => {
    const result = templatedReplyNetworkRule.evaluate(
      makeBundle(0, { recentTweetsFetchStatus: null }),
    )
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBe(0.5)
  })

  it('keeps a confident false when recentTweets were fetched successfully but no shared template exists', () => {
    const result = templatedReplyNetworkRule.evaluate(
      makeBundle(0, { recentTweetsFetchStatus: 'success' }),
    )
    expect(result.value).toBe(false)
    expect(result.evaluable ?? true).toBe(true)
    expect(result.confidence).toBe(1)
  })
})
