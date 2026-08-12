import { describe, expect, it } from 'vitest'
import { buildReviewTargetWindow, resolvePositiveInteger } from './review-plan-run'

describe('buildReviewTargetWindow', () => {
  it('run 開始時刻までの直近 7 日をレビュー対象にする', () => {
    const startedAt = new Date('2026-08-12T00:00:00Z')

    expect(buildReviewTargetWindow(startedAt)).toEqual({
      targetFrom: new Date('2026-08-05T00:00:00Z'),
      targetTo: startedAt,
    })
  })
})

describe('resolvePositiveInteger', () => {
  it('未指定なら既定値を返し、正整数だけを許可する', () => {
    expect(resolvePositiveInteger(undefined, 240, 'budget')).toBe(240)
    expect(resolvePositiveInteger('120', 240, 'budget')).toBe(120)
    expect(() => resolvePositiveInteger('0', 240, 'budget')).toThrow(
      'budget must be a positive integer',
    )
    expect(() => resolvePositiveInteger('abc', 240, 'budget')).toThrow(
      'budget must be a positive integer',
    )
  })
})
