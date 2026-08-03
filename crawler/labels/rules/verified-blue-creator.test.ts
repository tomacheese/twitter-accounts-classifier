import { describe, expect, it } from 'vitest'
import { verifiedBlueCreatorRule } from './verified-blue-creator'
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

describe('verifiedBlueCreatorRule', () => {
  it('is true when Blue-verified with no organization type and professionalType is Creator', () => {
    const result = verifiedBlueCreatorRule.evaluate(
      makeBundle({ isBlueVerified: true, professionalType: 'Creator' }),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })

  it('is false when professionalType is Business instead of Creator', () => {
    const result = verifiedBlueCreatorRule.evaluate(
      makeBundle({ isBlueVerified: true, professionalType: 'Business' }),
    )
    expect(result.value).toBe(false)
  })

  it('is false when professionalType is absent', () => {
    const result = verifiedBlueCreatorRule.evaluate(makeBundle({ isBlueVerified: true }))
    expect(result.value).toBe(false)
  })

  it('is false when the account has an organization verifiedType, even with professionalType Creator', () => {
    const result = verifiedBlueCreatorRule.evaluate(
      makeBundle({ isBlueVerified: true, verifiedType: 'Business', professionalType: 'Creator' }),
    )
    expect(result.value).toBe(false)
  })

  it('is false when isBlueVerified is false', () => {
    const result = verifiedBlueCreatorRule.evaluate(makeBundle({ professionalType: 'Creator' }))
    expect(result.value).toBe(false)
  })
})
