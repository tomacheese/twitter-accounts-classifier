import { describe, expect, it } from 'vitest'
import { parodyAccountRule } from './parody-account'
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

describe('parodyAccountRule', () => {
  it('is true when parodyCommentaryFanLabel is Parody', () => {
    const result = parodyAccountRule.evaluate(makeBundle({ parodyCommentaryFanLabel: 'Parody' }))
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })

  it('is false when parodyCommentaryFanLabel is Commentary', () => {
    const result = parodyAccountRule.evaluate(
      makeBundle({ parodyCommentaryFanLabel: 'Commentary' }),
    )
    expect(result.value).toBe(false)
  })

  it('is false when parodyCommentaryFanLabel is Fan', () => {
    const result = parodyAccountRule.evaluate(makeBundle({ parodyCommentaryFanLabel: 'Fan' }))
    expect(result.value).toBe(false)
  })

  it("is false when parodyCommentaryFanLabel is the literal string 'None'", () => {
    const result = parodyAccountRule.evaluate(makeBundle({ parodyCommentaryFanLabel: 'None' }))
    expect(result.value).toBe(false)
  })

  it('is false when parodyCommentaryFanLabel is null', () => {
    const result = parodyAccountRule.evaluate(makeBundle({ parodyCommentaryFanLabel: null }))
    expect(result.value).toBe(false)
  })

  it('is false when parodyCommentaryFanLabel is absent', () => {
    const result = parodyAccountRule.evaluate(makeBundle({}))
    expect(result.value).toBe(false)
  })
})
