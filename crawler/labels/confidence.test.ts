import { describe, expect, it } from 'vitest'
import {
  combineAlternatives,
  combineRequired,
  posteriorProbabilityAtLeast,
  rampScore,
  smoothedRate,
  toConfidence,
} from './confidence'

describe('rampScore', () => {
  it('returns 0.5 exactly at the threshold', () => {
    expect(rampScore(150, 150, 150, 'higher-is-positive')).toBeCloseTo(0.5)
    expect(rampScore(0.05, 0.05, 0.05, 'lower-is-positive')).toBeCloseTo(0.5)
  })

  it('saturates to 1 once rampWidth is exceeded in the positive direction', () => {
    expect(rampScore(300, 150, 150, 'higher-is-positive')).toBeCloseTo(1)
    expect(rampScore(1000, 150, 150, 'higher-is-positive')).toBe(1)
  })

  it('saturates to 0 once rampWidth is exceeded in the negative direction', () => {
    expect(rampScore(0, 150, 150, 'higher-is-positive')).toBeCloseTo(0)
    expect(rampScore(-100, 150, 150, 'higher-is-positive')).toBe(0)
  })

  it('inverts direction for lower-is-positive signals', () => {
    expect(rampScore(0, 0.05, 0.05, 'lower-is-positive')).toBeCloseTo(1)
    expect(rampScore(0.1, 0.05, 0.05, 'lower-is-positive')).toBeCloseTo(0)
  })
})

describe('combineRequired / combineAlternatives', () => {
  it('combineRequired preserves the >= 0.5 property when every input is >= 0.5', () => {
    expect(combineRequired([0.5, 0.7, 0.9])).toBeCloseTo(0.5)
    expect(combineRequired([0.6, 0.8])).toBeCloseTo(0.6)
  })

  it('combineRequired collapses to the minimum when one input is below 0.5', () => {
    expect(combineRequired([0.9, 0.3])).toBeCloseTo(0.3)
  })

  it('combineAlternatives takes the maximum', () => {
    expect(combineAlternatives([0.2, 0.6, 0.4])).toBeCloseTo(0.6)
  })
})

describe('toConfidence', () => {
  it('returns evidenceScore itself when value is true', () => {
    expect(toConfidence(true, 0.8)).toBeCloseTo(0.8)
  })

  it('inverts evidenceScore when value is false (no evidence -> confident negative)', () => {
    expect(toConfidence(false, 0)).toBeCloseTo(1)
    expect(toConfidence(false, 0.8)).toBeCloseTo(0.2)
  })

  it('ignores value/evidenceScore and returns 0.5 when evaluable is false', () => {
    expect(toConfidence(false, 0, false)).toBeCloseTo(0.5)
    expect(toConfidence(true, 1, false)).toBeCloseTo(0.5)
  })

  it('treats an omitted evaluable as true', () => {
    expect(toConfidence(true, 0.8)).toBe(toConfidence(true, 0.8, true))
  })
})

describe('smoothedRate', () => {
  it('shrinks small samples toward 0.5 under the default Beta(1, 1) prior', () => {
    expect(smoothedRate(1, 1)).toBeCloseTo(2 / 3)
    expect(smoothedRate(0, 1)).toBeCloseTo(1 / 3)
  })

  it('converges to the raw ratio as the sample grows', () => {
    expect(smoothedRate(700, 1000)).toBeCloseTo(0.7, 2)
  })
})

describe('posteriorProbabilityAtLeast / regularizedIncompleteBeta', () => {
  it('returns 0.5 for the symmetric reference case I_0.5(2, 2)', () => {
    // successCount=1, totalCount=2, Beta(1,1) 事前分布 -> Beta(2, 2) 事後分布
    expect(posteriorProbabilityAtLeast(1, 2, 0.5)).toBeCloseTo(0.5, 6)
  })

  it('matches known asymmetric reference values for the regularized incomplete beta function', () => {
    // I_0.3(2, 5) = 0.579825...、I_0.8(5, 2) = 0.65536 (二項展開による直接積分の参照値)。
    // posteriorProbabilityAtLeast は生存関数 1 - I_x(a, b) を返す。
    expect(posteriorProbabilityAtLeast(1, 5, 0.3)).toBeCloseTo(1 - 0.579_825, 5)
    expect(posteriorProbabilityAtLeast(4, 5, 0.8)).toBeCloseTo(1 - 0.655_36, 5)
  })

  it('approaches 0 as threshold approaches 1 and 1 as threshold approaches 0', () => {
    expect(posteriorProbabilityAtLeast(5, 10, 0.999_999)).toBeCloseTo(0, 4)
    expect(posteriorProbabilityAtLeast(5, 10, 0.000_001)).toBeCloseTo(1, 4)
  })

  it('is monotonically non-increasing as threshold increases for fixed successCount/totalCount', () => {
    const thresholds = [0.1, 0.3, 0.5, 0.7, 0.9]
    const values = thresholds.map((t) => posteriorProbabilityAtLeast(6, 10, t))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeLessThanOrEqual(values[i - 1])
    }
  })

  it('concentrates toward 1 as n grows when the true rate exceeds the threshold, holding the ratio fixed', () => {
    const small = posteriorProbabilityAtLeast(7, 10, 0.5)
    const large = posteriorProbabilityAtLeast(700, 1000, 0.5)
    expect(large).toBeGreaterThan(small)
    expect(large).toBeGreaterThan(0.99)
  })

  it('concentrates toward 0 as n grows when the true rate is below the threshold, holding the ratio fixed', () => {
    const small = posteriorProbabilityAtLeast(3, 10, 0.5)
    const large = posteriorProbabilityAtLeast(300, 1000, 0.5)
    expect(large).toBeLessThan(small)
    expect(large).toBeLessThan(0.01)
  })

  it('always returns a value within [0, 1]', () => {
    expect(posteriorProbabilityAtLeast(0, 0, 0.5)).toBeGreaterThanOrEqual(0)
    expect(posteriorProbabilityAtLeast(0, 0, 0.5)).toBeLessThanOrEqual(1)
    expect(posteriorProbabilityAtLeast(50, 50, 0.99)).toBeGreaterThanOrEqual(0)
    expect(posteriorProbabilityAtLeast(50, 50, 0.99)).toBeLessThanOrEqual(1)
  })

  it('throws when totalCount is less than successCount', () => {
    expect(() => posteriorProbabilityAtLeast(5, 3, 0.5)).toThrow()
  })

  it('throws when priorAlpha or priorBeta is negative', () => {
    expect(() => posteriorProbabilityAtLeast(1, 2, 0.5, -1)).toThrow()
    expect(() => posteriorProbabilityAtLeast(1, 2, 0.5, 1, -1)).toThrow()
  })

  it('throws when threshold is outside [0, 1]', () => {
    expect(() => posteriorProbabilityAtLeast(1, 2, -0.1)).toThrow()
    expect(() => posteriorProbabilityAtLeast(1, 2, 1.1)).toThrow()
  })
})
