import { describe, expect, it } from 'vitest'
import { hasFollowGraphTopicSignal } from './follow-graph-topic-signal'

describe('hasFollowGraphTopicSignal', () => {
  it('returns matched=false, evidenceScore=0, evaluable=false when signal is undefined', () => {
    const result = hasFollowGraphTopicSignal(undefined)
    expect(result).toEqual({ matched: false, evidenceScore: 0, evaluable: false })
  })

  it('returns matched=false, evidenceScore=0, evaluable=false when totalCount is below the minimum sample', () => {
    const result = hasFollowGraphTopicSignal({
      followeeTotalCount: 5,
      followeeLabeledCount: 5,
      followerTotalCount: 0,
      followerLabeledCount: 0,
    })
    expect(result.matched).toBe(false)
    expect(result.evidenceScore).toBe(0)
    expect(result.evaluable).toBe(false)
  })

  it('matches and returns a high evidenceScore when the labeled ratio clears the threshold', () => {
    const result = hasFollowGraphTopicSignal({
      followeeTotalCount: 100,
      followeeLabeledCount: 90,
      followerTotalCount: 0,
      followerLabeledCount: 0,
    })
    expect(result.matched).toBe(true)
    expect(result.evaluable).toBe(true)
    expect(result.evidenceScore).toBeGreaterThan(0.5)
  })

  it('does not match but is evaluable when totalCount is enough but the ratio is below threshold', () => {
    const result = hasFollowGraphTopicSignal({
      followeeTotalCount: 100,
      followeeLabeledCount: 5,
      followerTotalCount: 0,
      followerLabeledCount: 0,
    })
    expect(result.matched).toBe(false)
    expect(result.evaluable).toBe(true)
    expect(result.evidenceScore).toBeLessThan(0.5)
  })

  it('respects overridden thresholds', () => {
    const result = hasFollowGraphTopicSignal(
      {
        followeeTotalCount: 10,
        followeeLabeledCount: 5,
        followerTotalCount: 0,
        followerLabeledCount: 0,
      },
      { minFolloweeSample: 5, minFolloweeLabeledRatio: 0.4 },
    )
    expect(result.matched).toBe(true)
    expect(result.evaluable).toBe(true)
  })
})
