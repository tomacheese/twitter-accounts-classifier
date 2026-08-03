import { describe, expect, it } from 'vitest'
import { hasFollowGraphTopicSignal } from './follow-graph-topic-signal'
import type { FollowGraphLabelSignal } from './follow-graph-label-index'

function makeSignal(
  followeeLabeledCount: number,
  followeeTotalCount: number,
): FollowGraphLabelSignal {
  return {
    followeeLabeledCount,
    followeeTotalCount,
    followerLabeledCount: 0,
    followerTotalCount: 0,
  }
}

describe('hasFollowGraphTopicSignal', () => {
  it('signal が undefined の場合は false になる', () => {
    expect(hasFollowGraphTopicSignal(undefined)).toBe(false)
  })

  it('サンプル数がしきい値ちょうどで、比率がしきい値を上回っている場合は true になる', () => {
    expect(hasFollowGraphTopicSignal(makeSignal(5, 15))).toBe(true)
  })

  it('サンプル数がしきい値未満の場合は比率を満たしていても false になる', () => {
    expect(hasFollowGraphTopicSignal(makeSignal(14, 14))).toBe(false)
  })

  it('比率がしきい値未満の場合は false になる', () => {
    expect(hasFollowGraphTopicSignal(makeSignal(4, 15))).toBe(false)
  })

  it('options でしきい値を上書きできる', () => {
    expect(
      hasFollowGraphTopicSignal(makeSignal(1, 5), {
        minFolloweeSample: 5,
        minFolloweeLabeledRatio: 0.2,
      }),
    ).toBe(true)
  })
})
