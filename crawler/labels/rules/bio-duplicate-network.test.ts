import { describe, expect, it } from 'vitest'
import { bioDuplicateNetworkRule } from './bio-duplicate-network'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  bioDuplicateNetworkSize: number | undefined,
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

  it('is false with neutral evaluable=false when the account has no bio, instead of a confident false', () => {
    const result = bioDuplicateNetworkRule.evaluate(makeBundle(0, { bio: null }))
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBe(0.5)
  })

  it('keeps a confident false when the account has a bio but no duplicate network was found', () => {
    const result = bioDuplicateNetworkRule.evaluate(makeBundle(0, { bio: 'こんにちは' }))
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(true)
    expect(result.confidence).toBe(1)
  })
})
