import { describe, it, expect } from 'vitest'
import { evaluateReasonDistributionShifts } from './reason-distribution-shift'

describe('evaluateReasonDistributionShifts', () => {
  it('1 つの reason だけ相対閾値を超えたら、その reason で exceeded: true を返す', () => {
    const results = evaluateReasonDistributionShifts(
      {
        current: { bio_pattern: 10, screen_name_pattern: 20 },
        baseline: { bio_pattern: 30, screen_name_pattern: 20 },
      },
      { relativeThreshold: 0.4, minimumSampleSize: 10 },
    )
    const bioPattern = results.find((result) => result.reason === 'bio_pattern')
    expect(bioPattern?.exceeded).toBe(true)
    const screenNamePattern = results.find((result) => result.reason === 'screen_name_pattern')
    expect(screenNamePattern?.exceeded).toBe(false)
  })

  it('複数の reason が同時に閾値を超えたら、それぞれ独立して exceeded: true を返す', () => {
    const results = evaluateReasonDistributionShifts(
      {
        current: { bio_pattern: 5, screen_name_pattern: 8, tweet_text_pattern: 20 },
        baseline: { bio_pattern: 30, screen_name_pattern: 20, tweet_text_pattern: 22 },
      },
      { relativeThreshold: 0.3, minimumSampleSize: 5 },
    )
    expect(
      results
        .filter((result) => result.exceeded)
        .map((result) => result.reason)
        .toSorted(),
    ).toEqual(['bio_pattern', 'screen_name_pattern'].toSorted())
  })

  it('閾値未満の変化は検出しない', () => {
    const results = evaluateReasonDistributionShifts(
      { current: { bio_pattern: 19 }, baseline: { bio_pattern: 20 } },
      { relativeThreshold: 0.4, minimumSampleSize: 5 },
    )
    expect(results).toHaveLength(1)
    expect(results[0]?.exceeded).toBe(false)
  })

  it('baseline の母数が minimumSampleSize 未満の reason は結果に含めない', () => {
    const results = evaluateReasonDistributionShifts(
      { current: { bio_pattern: 1 }, baseline: { bio_pattern: 2 } },
      { relativeThreshold: 0.4, minimumSampleSize: 5 },
    )
    expect(results).toHaveLength(0)
  })
})
