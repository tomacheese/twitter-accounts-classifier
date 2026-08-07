import { describe, it, expect } from 'vitest'
import { computeFreshnessStatus } from './freshness'

describe('computeFreshnessStatus', () => {
  const cadenceMs = 6 * 60 * 60 * 1000

  it('予定範囲内なら current を返す', () => {
    const now = new Date('2026-08-07T12:00:00Z')
    const lastSuccessAt = new Date('2026-08-07T07:00:00Z')
    expect(
      computeFreshnessStatus({
        lastSuccessAt,
        cadenceMs,
        delayedAfterMs: cadenceMs * 1.5,
        staleAfterMs: cadenceMs * 3,
        now,
      }),
    ).toBe('current')
  })

  it('delayedAfter を超えたら delayed を返す', () => {
    const now = new Date('2026-08-07T16:00:00Z')
    const lastSuccessAt = new Date('2026-08-07T07:00:00Z')
    expect(
      computeFreshnessStatus({
        lastSuccessAt,
        cadenceMs,
        delayedAfterMs: cadenceMs * 1.5,
        staleAfterMs: cadenceMs * 3,
        now,
      }),
    ).toBe('delayed')
  })

  it('staleAfter を超えたら stale を返す', () => {
    const now = new Date('2026-08-08T08:00:00Z')
    const lastSuccessAt = new Date('2026-08-07T07:00:00Z')
    expect(
      computeFreshnessStatus({
        lastSuccessAt,
        cadenceMs,
        delayedAfterMs: cadenceMs * 1.5,
        staleAfterMs: cadenceMs * 3,
        now,
      }),
    ).toBe('stale')
  })

  it('lastSuccessAt が無ければ unknown を返す', () => {
    const now = new Date('2026-08-07T12:00:00Z')
    expect(
      computeFreshnessStatus({
        lastSuccessAt: undefined,
        cadenceMs,
        delayedAfterMs: cadenceMs * 1.5,
        staleAfterMs: cadenceMs * 3,
        now,
      }),
    ).toBe('unknown')
  })
})
