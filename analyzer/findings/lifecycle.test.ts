import { describe, it, expect } from 'vitest'
import { applyLifecycleTransition, type FindingLifecycleState } from './lifecycle'
import type { DetectionPolicyRule } from '../policy/schema'

const rule: DetectionPolicyRule = {
  type: 'label_count_drop',
  enabled: true,
  detectorType: 'comparative',
  identityVersion: 1,
  severity: 'high',
  activationCount: 2,
  resolutionCount: 2,
  criticalImmediate: false,
  recurrenceWindow: 'P30D',
}

describe('applyLifecycleTransition', () => {
  it('activationCount 未満の連続超過では active 化しない', () => {
    const state: FindingLifecycleState = { status: 'none', consecutiveExceed: 0, consecutiveNormal: 0 }
    const next = applyLifecycleTransition(state, { exceeded: true, isMissingOrFailed: false }, rule, new Date())
    expect(next.status).toBe('none')
    expect(next.consecutiveExceed).toBe(1)
  })

  it('activationCount に達すると active 化する', () => {
    const state: FindingLifecycleState = { status: 'none', consecutiveExceed: 1, consecutiveNormal: 0 }
    const next = applyLifecycleTransition(state, { exceeded: true, isMissingOrFailed: false }, rule, new Date())
    expect(next.status).toBe('active')
  })

  it('criticalImmediate な rule は 1 回の超過で active 化する', () => {
    const state: FindingLifecycleState = { status: 'none', consecutiveExceed: 0, consecutiveNormal: 0 }
    const next = applyLifecycleTransition(
      state,
      { exceeded: true, isMissingOrFailed: false },
      { ...rule, criticalImmediate: true },
      new Date(),
    )
    expect(next.status).toBe('active')
  })

  it('母数不足・評価失敗は連続回数を進めない', () => {
    const state: FindingLifecycleState = { status: 'none', consecutiveExceed: 1, consecutiveNormal: 0 }
    const next = applyLifecycleTransition(state, { exceeded: true, isMissingOrFailed: true }, rule, new Date())
    expect(next.consecutiveExceed).toBe(1)
    expect(next.status).toBe('none')
  })

  it('resolutionCount に達すると resolved 化する', () => {
    const state: FindingLifecycleState = { status: 'active', consecutiveExceed: 2, consecutiveNormal: 1 }
    const next = applyLifecycleTransition(state, { exceeded: false, isMissingOrFailed: false }, rule, new Date())
    expect(next.status).toBe('resolved')
  })

  it('recurrenceWindow 内の再発は recurring になる', () => {
    const resolvedAt = new Date('2026-08-01T00:00:00Z')
    const state: FindingLifecycleState = {
      status: 'resolved',
      consecutiveExceed: 0,
      consecutiveNormal: 2,
      resolvedAt,
    }
    const next = applyLifecycleTransition(
      state,
      { exceeded: true, isMissingOrFailed: false },
      { ...rule, activationCount: 1 },
      new Date('2026-08-05T00:00:00Z'),
    )
    expect(next.status).toBe('recurring')
  })

  it('recurrenceWindow を超えた再発は新規 episode 扱いにする', () => {
    const resolvedAt = new Date('2026-01-01T00:00:00Z')
    const state: FindingLifecycleState = {
      status: 'resolved',
      consecutiveExceed: 0,
      consecutiveNormal: 2,
      resolvedAt,
    }
    const next = applyLifecycleTransition(
      state,
      { exceeded: true, isMissingOrFailed: false },
      { ...rule, activationCount: 1 },
      new Date('2026-08-05T00:00:00Z'),
    )
    expect(next.status).toBe('new_episode')
  })
})
