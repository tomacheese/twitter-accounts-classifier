import { describe, expect, it } from 'vitest'
import { classifyPrStatus, type PrSnapshot } from './pr-lifecycle'

function baseSnapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: { enabledAt: '2026-08-05T00:00:00Z' },
    reviewDecision: null,
    statusCheckRollup: [
      { name: 'Node CI / Check finished Node CI', conclusion: 'SUCCESS', status: 'COMPLETED' },
    ],
    ...overrides,
  }
}

describe('classifyPrStatus', () => {
  it('classifies a merged PR as merged regardless of other fields', () => {
    expect(classifyPrStatus(baseSnapshot({ state: 'MERGED' }))).toBe('merged')
  })

  it('classifies a closed, unmerged PR as closed', () => {
    expect(classifyPrStatus(baseSnapshot({ state: 'CLOSED' }))).toBe('closed')
  })

  it('classifies a PR with the required check passing and no blockers as ready', () => {
    expect(classifyPrStatus(baseSnapshot())).toBe('ready')
  })

  it('classifies a PR missing a required check result as waiting_checks', () => {
    const snapshot = baseSnapshot({
      statusCheckRollup: [
        { name: 'Node CI / Check finished Node CI', conclusion: null, status: 'IN_PROGRESS' },
      ],
    })
    expect(classifyPrStatus(snapshot)).toBe('waiting_checks')
  })

  it('classifies a PR with a failing required check as failed_checks even if review is approved', () => {
    const snapshot = baseSnapshot({
      reviewDecision: 'APPROVED',
      statusCheckRollup: [
        { name: 'Node CI / Check finished Node CI', conclusion: 'FAILURE', status: 'COMPLETED' },
      ],
    })
    expect(classifyPrStatus(snapshot)).toBe('failed_checks')
  })

  it('classifies a PR with unresolved review request as review_required', () => {
    expect(classifyPrStatus(baseSnapshot({ reviewDecision: 'REVIEW_REQUIRED' }))).toBe(
      'review_required',
    )
  })

  it('classifies a conflicting PR as merge_blocked', () => {
    expect(classifyPrStatus(baseSnapshot({ mergeable: 'CONFLICTING' }))).toBe('merge_blocked')
  })

  it('classifies an unknown mergeability as mergeability_unknown', () => {
    expect(classifyPrStatus(baseSnapshot({ mergeable: 'UNKNOWN' }))).toBe('mergeability_unknown')
  })

  it('classifies a PR without auto-merge enabled as auto_merge_disabled', () => {
    expect(classifyPrStatus(baseSnapshot({ autoMergeRequest: null }))).toBe('auto_merge_disabled')
  })

  it('does not match a check whose name only partially overlaps a required check name', () => {
    const snapshot = baseSnapshot({
      statusCheckRollup: [
        {
          name: 'Node CI / Check finished Node CI (extra)',
          conclusion: 'SUCCESS',
          status: 'COMPLETED',
        },
      ],
    })
    expect(classifyPrStatus(snapshot)).toBe('waiting_checks')
  })
})
