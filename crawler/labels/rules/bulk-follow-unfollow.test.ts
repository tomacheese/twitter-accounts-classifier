import { describe, expect, it } from 'vitest'
import { bulkFollowUnfollowRule } from './bulk-follow-unfollow'
import type { AccountFeatureBundle } from '../types'

function makeBundle(
  followChurnObservation: AccountFeatureBundle['followChurnObservation'],
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
    },
    recentTweets: [],
    followChurnObservation,
  }
}

describe('bulkFollowUnfollowRule', () => {
  it('is true when completedCycles reaches the threshold', () => {
    const result = bulkFollowUnfollowRule.evaluate(
      makeBundle({ followed: 12, unfollowed: 12, completedCycles: 12 }),
    )
    expect(result.value).toBe(true)
    expect(result.evaluable).toBe(true)
  })

  it('is false when completedCycles is just below the threshold', () => {
    const result = bulkFollowUnfollowRule.evaluate(
      makeBundle({ followed: 11, unfollowed: 11, completedCycles: 11 }),
    )
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(true)
  })

  it('is not evaluable when followChurnObservation is unset', () => {
    const result = bulkFollowUnfollowRule.evaluate(makeBundle(undefined))
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
    expect(result.confidence).toBe(0.5)
  })

  it('is not evaluable when there are too few raw events to distinguish "no churn" from "no observation opportunity"', () => {
    const result = bulkFollowUnfollowRule.evaluate(
      makeBundle({ followed: 1, unfollowed: 1, completedCycles: 0 }),
    )
    expect(result.value).toBe(false)
    expect(result.evaluable).toBe(false)
  })

  it('is not evaluable when total events is just below the evaluation threshold', () => {
    const result = bulkFollowUnfollowRule.evaluate(
      makeBundle({ followed: 2, unfollowed: 1, completedCycles: 0 }),
    )
    expect(result.evaluable).toBe(false)
  })

  it('is evaluable once total events reaches the evaluation threshold', () => {
    const result = bulkFollowUnfollowRule.evaluate(
      makeBundle({ followed: 2, unfollowed: 2, completedCycles: 0 }),
    )
    expect(result.evaluable).toBe(true)
  })

  it('sets excludeFromStaleScan to true so future threshold tuning does not trigger a full backfill', () => {
    expect(bulkFollowUnfollowRule.excludeFromStaleScan).toBe(true)
  })
})
