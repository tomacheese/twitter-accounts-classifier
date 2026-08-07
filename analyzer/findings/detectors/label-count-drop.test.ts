import { describe, it, expect } from 'vitest'
import { evaluateLabelCountDrop } from './label-count-drop'

describe('evaluateLabelCountDrop', () => {
  it('相対閾値を超えた減少を検出する', () => {
    const result = evaluateLabelCountDrop(
      { current: { trueCount: 50, evaluatedCount: 1000 }, baseline: { trueCount: 100, evaluatedCount: 1000 } },
      { relativeThreshold: 0.3, minimumSampleSize: 50 },
    )
    expect(result.exceeded).toBe(true)
    expect(result.isMissingOrFailed).toBe(false)
  })

  it('最低母数未満なら missing 扱いにする', () => {
    const result = evaluateLabelCountDrop(
      { current: { trueCount: 2, evaluatedCount: 10 }, baseline: { trueCount: 100, evaluatedCount: 1000 } },
      { relativeThreshold: 0.3, minimumSampleSize: 50 },
    )
    expect(result.isMissingOrFailed).toBe(true)
  })

  it('閾値未満の変化は検出しない', () => {
    const result = evaluateLabelCountDrop(
      { current: { trueCount: 95, evaluatedCount: 1000 }, baseline: { trueCount: 100, evaluatedCount: 1000 } },
      { relativeThreshold: 0.3, minimumSampleSize: 50 },
    )
    expect(result.exceeded).toBe(false)
  })
})
