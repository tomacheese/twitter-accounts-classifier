import { describe, it, expect } from 'vitest'
import { detectionPolicySchema } from './schema'

describe('detectionPolicySchema', () => {
  it('必須フィールドを満たす rule を受理する', () => {
    const result = detectionPolicySchema.safeParse({
      schemaVersion: 1,
      policyVersion: '2026-08-07.0',
      rules: [
        {
          type: 'label_count_drop',
          enabled: true,
          detectorType: 'comparative',
          identityVersion: 1,
          severity: 'high',
          minimumSampleSize: 50,
          relativeThreshold: 0.3,
          baselineWindow: 'previous_cycle',
          activationCount: 2,
          resolutionCount: 2,
          recurrenceWindow: 'P30D',
          cooldown: 'PT1H',
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('severity が不正な値なら拒否する', () => {
    const result = detectionPolicySchema.safeParse({
      schemaVersion: 1,
      policyVersion: '2026-08-07.0',
      rules: [
        {
          type: 'label_count_drop',
          enabled: true,
          detectorType: 'comparative',
          identityVersion: 1,
          severity: 'urgent',
        },
      ],
    })
    expect(result.success).toBe(false)
  })
})
