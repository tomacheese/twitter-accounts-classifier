import { describe, it, expect } from 'vitest'
import { computePolicyHash } from './policy-hash'
import type { DetectionPolicy } from './schema'

const base: DetectionPolicy = {
  schemaVersion: 1,
  policyVersion: '2026-08-07.0',
  rules: [
    {
      type: 'label_count_drop',
      enabled: true,
      detectorType: 'comparative',
      identityVersion: 1,
      severity: 'high',
      activationCount: 1,
      resolutionCount: 1,
      criticalImmediate: false,
    },
  ],
}

describe('computePolicyHash', () => {
  it('同じ内容なら同じ hash を返す', () => {
    expect(computePolicyHash(base)).toBe(computePolicyHash({ ...base }))
  })

  it('キー順序が異なる同一内容でも同じ hash を返す', () => {
    const reordered = {
      rules: base.rules,
      policyVersion: base.policyVersion,
      schemaVersion: base.schemaVersion,
    }
    expect(computePolicyHash(base)).toBe(computePolicyHash(reordered as DetectionPolicy))
  })
})
