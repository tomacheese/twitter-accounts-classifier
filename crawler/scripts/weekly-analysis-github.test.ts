import { describe, expect, it } from 'vitest'
import { isPrSnapshot } from './weekly-analysis-github'

function validSnapshot(): Record<string, unknown> {
  return {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: null,
    reviewDecision: null,
    statusCheckRollup: [],
  }
}

describe('isPrSnapshot', () => {
  it('accepts a snapshot with valid state, mergeable and statusCheckRollup', () => {
    expect(isPrSnapshot(validSnapshot())).toBe(true)
  })

  it('rejects a non-object value', () => {
    expect(isPrSnapshot(null)).toBe(false)
    expect(isPrSnapshot('OPEN')).toBe(false)
  })

  it('rejects an unknown state value', () => {
    expect(isPrSnapshot({ ...validSnapshot(), state: 'ARCHIVED' })).toBe(false)
  })

  it('rejects an unknown mergeable value', () => {
    expect(isPrSnapshot({ ...validSnapshot(), mergeable: 'UNSURE' })).toBe(false)
  })

  it('rejects a missing statusCheckRollup array', () => {
    const snapshot = validSnapshot()
    delete snapshot.statusCheckRollup
    expect(isPrSnapshot(snapshot)).toBe(false)
  })
})
