import { describe, it, expect } from 'vitest'
import { computeFingerprint } from './fingerprint'

describe('computeFingerprint', () => {
  it('type と dimensions から安定した文字列を作る', () => {
    const a = computeFingerprint('label_count_drop', { label: 'label-abc' })
    const b = computeFingerprint('label_count_drop', { label: 'label-abc' })
    expect(a).toBe(b)
  })

  it('dimensions のキー順序に依存しない', () => {
    const a = computeFingerprint('reason_distribution_shift', {
      label: 'label-abc',
      reason: 'bio_pattern',
    })
    const b = computeFingerprint('reason_distribution_shift', {
      reason: 'bio_pattern',
      label: 'label-abc',
    })
    expect(a).toBe(b)
  })

  it('severity や実測値は fingerprint の入力に含まれない (呼び出し側の型で強制する)', () => {
    const withoutVolatileFields = computeFingerprint('label_count_drop', { label: 'label-abc' })
    expect(withoutVolatileFields).not.toContain('severity')
  })
})
