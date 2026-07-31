import { describe, expect, it } from 'vitest'
import { verifiedBusinessRule } from './verified-business'
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

describe('verifiedBusinessRule', () => {
  it('is true when verifiedType is Business, even without an active Blue subscription', () => {
    const result = verifiedBusinessRule.evaluate(
      makeBundle({ verifiedType: 'Business', isBlueVerified: false })
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })

  it('is true when verifiedType is Business and isBlueVerified is true', () => {
    const result = verifiedBusinessRule.evaluate(
      makeBundle({ verifiedType: 'Business', isBlueVerified: true })
    )
    expect(result.value).toBe(true)
  })

  it('is false when verifiedType is Government', () => {
    const result = verifiedBusinessRule.evaluate(makeBundle({ verifiedType: 'Government' }))
    expect(result.value).toBe(false)
  })

  it('is false when verifiedType is absent', () => {
    const result = verifiedBusinessRule.evaluate(makeBundle({ isBlueVerified: true }))
    expect(result.value).toBe(false)
  })
})
