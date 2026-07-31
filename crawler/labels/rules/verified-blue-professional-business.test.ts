import { describe, expect, it } from 'vitest'
import { verifiedBlueProfessionalBusinessRule } from './verified-blue-professional-business'
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

describe('verifiedBlueProfessionalBusinessRule', () => {
  it('is true when Blue-verified with no organization type and professionalType is Business', () => {
    const result = verifiedBlueProfessionalBusinessRule.evaluate(
      makeBundle({ isBlueVerified: true, professionalType: 'Business' })
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })

  it('is false when professionalType is Creator instead of Business', () => {
    const result = verifiedBlueProfessionalBusinessRule.evaluate(
      makeBundle({ isBlueVerified: true, professionalType: 'Creator' })
    )
    expect(result.value).toBe(false)
  })

  it('is false when professionalType is absent', () => {
    const result = verifiedBlueProfessionalBusinessRule.evaluate(makeBundle({ isBlueVerified: true }))
    expect(result.value).toBe(false)
  })

  it('is false when the account has an organization verifiedType, even with professionalType Business', () => {
    const result = verifiedBlueProfessionalBusinessRule.evaluate(
      makeBundle({ isBlueVerified: true, verifiedType: 'Business', professionalType: 'Business' })
    )
    expect(result.value).toBe(false)
  })

  it('is false when isBlueVerified is false', () => {
    const result = verifiedBlueProfessionalBusinessRule.evaluate(makeBundle({ professionalType: 'Business' }))
    expect(result.value).toBe(false)
  })
})
