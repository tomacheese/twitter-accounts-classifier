import { describe, expect, it } from 'vitest'
import { bioDuplicateNetworkRule } from './bio-duplicate-network'
import type { AccountFeatureBundle } from '../types'

function makeBundle(bioDuplicateNetworkSize: number | undefined): AccountFeatureBundle {
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
    recentTweets: [],
    bioDuplicateNetworkSize,
  }
}

describe('bioDuplicateNetworkRule', () => {
  it('is true when at least 5 other accounts share the same normalized bio', () => {
    const result = bioDuplicateNetworkRule.evaluate(makeBundle(5))
    expect(result.value).toBe(true)
  })

  it('is false when fewer than 5 other accounts share the bio', () => {
    const result = bioDuplicateNetworkRule.evaluate(makeBundle(4))
    expect(result.value).toBe(false)
  })

  it('is false when the bundle does not populate bioDuplicateNetworkSize', () => {
    const result = bioDuplicateNetworkRule.evaluate(makeBundle(undefined))
    expect(result.value).toBe(false)
  })

  it('caps confidence at 1 for very large networks', () => {
    const result = bioDuplicateNetworkRule.evaluate(makeBundle(100))
    expect(result.confidence).toBe(1)
  })
})
