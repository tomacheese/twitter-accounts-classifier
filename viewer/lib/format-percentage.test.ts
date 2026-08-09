import { describe, it, expect } from 'vitest'
import { formatPercentage } from './format-percentage'

describe('formatPercentage', () => {
  it('0 は 0.0% を返す', () => {
    expect(formatPercentage(0)).toBe('0.0%')
  })
  it('0.0005 (0.05%) は < 0.1% を返す', () => {
    expect(formatPercentage(0.0005)).toBe('< 0.1%')
  })
  it('境界値 0.001 (0.1%) は 0.1% を返す', () => {
    expect(formatPercentage(0.001)).toBe('0.1%')
  })
  it('通常値 0.1 (10%) は 10.0% を返す', () => {
    expect(formatPercentage(0.1)).toBe('10.0%')
  })
})
