import { describe, expect, it } from 'vitest'
import { verifiedGovernmentRule } from './verified-government'
import type { AccountFeatureBundle } from '../types'

function makeBundle(overrides: Partial<AccountFeatureBundle['account']>): AccountFeatureBundle {
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
      ...overrides,
    },
    recentTweets: [],
  }
}

describe('verifiedGovernmentRule', () => {
  it('is true when verifiedType is Government, even without an active Blue subscription', () => {
    const result = verifiedGovernmentRule.evaluate(
      makeBundle({ verifiedType: 'Government', isBlueVerified: false }),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })

  it('is true when verifiedType is Government and isBlueVerified is true', () => {
    const result = verifiedGovernmentRule.evaluate(
      makeBundle({ verifiedType: 'Government', isBlueVerified: true }),
    )
    expect(result.value).toBe(true)
  })

  it('is false when verifiedType is Business', () => {
    const result = verifiedGovernmentRule.evaluate(makeBundle({ verifiedType: 'Business' }))
    expect(result.value).toBe(false)
  })

  it('is false when verifiedType is absent', () => {
    const result = verifiedGovernmentRule.evaluate(makeBundle({ isBlueVerified: true }))
    expect(result.value).toBe(false)
  })
})
