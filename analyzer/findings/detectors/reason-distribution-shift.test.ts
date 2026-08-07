import { describe, it, expect } from 'vitest'
import { evaluateReasonDistributionShift } from './reason-distribution-shift'

describe('evaluateReasonDistributionShift', () => {
  it('1 つの reason だけ相対閾値を超えたら、その reason key で exceeded: true を返す', () => {
    const result = evaluateReasonDistributionShift(
      {
        current: { bio_pattern: 10, screen_name_pattern: 20 },
        baseline: { bio_pattern: 30, screen_name_pattern: 20 },
      },
      { relativeThreshold: 0.4, minimumSampleSize: 10 },
    )
    expect(result.exceeded).toBe(true)
    expect(result.reason).toBe('bio_pattern')
  })

  it('複数の reason が同時に超えても、変化幅が最大の 1 件だけを返す', () => {
    const result = evaluateReasonDistributionShift(
      {
        current: { bio_pattern: 5, screen_name_pattern: 8, tweet_text_pattern: 20 },
        baseline: { bio_pattern: 30, screen_name_pattern: 20, tweet_text_pattern: 22 },
      },
      { relativeThreshold: 0.3, minimumSampleSize: 5 },
    )
    expect(result.exceeded).toBe(true)
    expect(result.reason).toBe('bio_pattern')
  })

  it('閾値未満の変化は検出しない', () => {
    const result = evaluateReasonDistributionShift(
      { current: { bio_pattern: 19 }, baseline: { bio_pattern: 20 } },
      { relativeThreshold: 0.4, minimumSampleSize: 5 },
    )
    expect(result.exceeded).toBe(false)
  })
})
