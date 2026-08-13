import { describe, it, expect } from 'vitest'
import { deriveElapsedFreshness, extractFreshnessThresholds } from './policy-freshness'
import { parseIsoDurationMs } from 'pipeline-health'

describe('parseIsoDurationMs', () => {
  it('日数を解釈する', () => {
    expect(parseIsoDurationMs('P30D')).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it('時間を解釈する', () => {
    expect(parseIsoDurationMs('PT3H')).toBe(3 * 60 * 60 * 1000)
  })

  it('不正な形式は例外を投げる', () => {
    expect(() => parseIsoDurationMs('invalid')).toThrow()
  })
})

describe('extractFreshnessThresholds', () => {
  it('read_model_freshness から分類 freshness のしきい値を取り出す', () => {
    const content = {
      pipelineHealth: {
        projection: { delayedAfter: 'PT1H', staleAfter: 'PT6H' },
      },
      rules: [
        { type: 'read_model_freshness', enabled: true, delayedAfter: 'PT1H', staleAfter: 'PT6H' },
      ],
    }
    expect(extractFreshnessThresholds(content)).toEqual({
      delayedAfterMs: 60 * 60 * 1000,
      staleAfterMs: 6 * 60 * 60 * 1000,
    })
  })

  it('read model rule が無効なら分類 freshness の既定値を返す', () => {
    const content = {
      rules: [
        { type: 'read_model_freshness', enabled: false, delayedAfter: 'PT1H', staleAfter: 'PT6H' },
      ],
    }
    expect(extractFreshnessThresholds(content)).toEqual({
      delayedAfterMs: 3 * 60 * 60 * 1000,
      staleAfterMs: 12 * 60 * 60 * 1000,
    })
  })

  it('policy が未ロードなら既定値を返す', () => {
    expect(extractFreshnessThresholds(null)).toEqual({
      delayedAfterMs: 3 * 60 * 60 * 1000,
      staleAfterMs: 12 * 60 * 60 * 1000,
    })
  })
})

describe('deriveElapsedFreshness', () => {
  const thresholds = { delayedAfterMs: 60 * 60 * 1000, staleAfterMs: 6 * 60 * 60 * 1000 }
  const now = new Date('2026-08-08T12:00:00Z')

  it('lastSuccessAt が無ければ undefined を返す', () => {
    expect(deriveElapsedFreshness(null, thresholds, now)).toBeUndefined()
  })

  it('しきい値未満なら undefined を返す', () => {
    expect(
      deriveElapsedFreshness(new Date('2026-08-08T11:50:00Z'), thresholds, now),
    ).toBeUndefined()
  })

  it('delayed しきい値を超えたら delayed を返す', () => {
    expect(deriveElapsedFreshness(new Date('2026-08-08T10:30:00Z'), thresholds, now)).toBe(
      'delayed',
    )
  })

  it('stale しきい値を超えたら stale を返す', () => {
    expect(deriveElapsedFreshness(new Date('2026-08-08T05:00:00Z'), thresholds, now)).toBe('stale')
  })
})
