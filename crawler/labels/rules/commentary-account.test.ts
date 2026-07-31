import { describe, expect, it } from 'vitest'
import { commentaryAccountRule } from './commentary-account'
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

describe('commentaryAccountRule', () => {
  it('is true when parodyCommentaryFanLabel is Commentary', () => {
    const result = commentaryAccountRule.evaluate(
      makeBundle({ parodyCommentaryFanLabel: 'Commentary' }),
    )
    expect(result.value).toBe(true)
    expect(result.confidence).toBe(1)
  })

  it('is false when parodyCommentaryFanLabel is Parody', () => {
    const result = commentaryAccountRule.evaluate(
      makeBundle({ parodyCommentaryFanLabel: 'Parody' }),
    )
    expect(result.value).toBe(false)
  })

  it('is false when parodyCommentaryFanLabel is Fan', () => {
    const result = commentaryAccountRule.evaluate(makeBundle({ parodyCommentaryFanLabel: 'Fan' }))
    expect(result.value).toBe(false)
  })

  it("is false when parodyCommentaryFanLabel is the literal string 'None'", () => {
    const result = commentaryAccountRule.evaluate(makeBundle({ parodyCommentaryFanLabel: 'None' }))
    expect(result.value).toBe(false)
  })

  it('is false when parodyCommentaryFanLabel is null', () => {
    const result = commentaryAccountRule.evaluate(makeBundle({ parodyCommentaryFanLabel: null }))
    expect(result.value).toBe(false)
  })

  it('is false when parodyCommentaryFanLabel is absent', () => {
    const result = commentaryAccountRule.evaluate(makeBundle({}))
    expect(result.value).toBe(false)
  })
})
