import { describe, expect, it } from 'vitest'
import { verifiedBlueIndividualRule } from './verified-blue-individual'
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

describe('verifiedBlueIndividualRule', () => {
  it('is true when isBlueVerified is true and verifiedType is absent', () => {
    const result = verifiedBlueIndividualRule.evaluate(makeBundle({ isBlueVerified: true }))
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })

  it('is true when isBlueVerified is true and verifiedType is the literal string None', () => {
    const result = verifiedBlueIndividualRule.evaluate(
      makeBundle({ isBlueVerified: true, verifiedType: 'None' }),
    )
    expect(result.value).toBe(true)
  })

  it('is false when isBlueVerified is true but verifiedType is an organization type', () => {
    const result = verifiedBlueIndividualRule.evaluate(
      makeBundle({ isBlueVerified: true, verifiedType: 'Business' }),
    )
    expect(result.value).toBe(false)
  })

  it('is false when isBlueVerified is false', () => {
    const result = verifiedBlueIndividualRule.evaluate(makeBundle({}))
    expect(result.value).toBe(false)
  })
})
