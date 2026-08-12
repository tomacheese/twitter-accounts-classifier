import { describe, expect, it } from 'vitest'
import { extractPlannedAccountIds, validateReviewResultAgainstPlan } from './validate-review-result'

const plan = {
  schemaVersion: 1,
  strategyVersion: 'risk-stratified/1',
  seed: 'run-1',
  budget: 240,
  targetFrom: '2026-08-05T00:00:00.000Z',
  targetTo: '2026-08-12T00:00:00.000Z',
  labels: [],
  samples: [{ sampleId: 'l1:a1' }, { sampleId: 'l1:a2' }],
}

function result(sampleIds: string[]) {
  return {
    schemaVersion: 2,
    review: {
      strategyVersion: 'risk-stratified/1',
      seed: 'run-1',
      plannedSampleCount: sampleIds.length,
      judgments: sampleIds.map((sampleId) => ({ sampleId })),
    },
  }
}

describe('validateReviewResultAgainstPlan', () => {
  it('plan の全 sample を一対一で judgment していれば受理する', () => {
    expect(() => {
      validateReviewResultAgainstPlan(plan, result(['l1:a1', 'l1:a2']))
    }).not.toThrow()
  })

  it('plan sample が 1 件でも欠けていれば拒否する', () => {
    expect(() => {
      validateReviewResultAgainstPlan(plan, result(['l1:a1']))
    }).toThrow('review judgments do not exactly cover review plan samples')
  })

  it('plan に無い sample を追加しても拒否する', () => {
    expect(() => {
      validateReviewResultAgainstPlan(plan, result(['l1:a1', 'l1:a2', 'l1:a3']))
    }).toThrow('review judgments do not exactly cover review plan samples')
  })

  it('strategyVersion または seed が plan と違えば拒否する', () => {
    expect(() => {
      validateReviewResultAgainstPlan(plan, {
        ...result(['l1:a1', 'l1:a2']),
        review: { ...result(['l1:a1', 'l1:a2']).review, seed: 'other-run' },
      })
    }).toThrow('review result does not match review plan identity')
  })

  it('plan が存在する run では structured output v2 を必須にする', () => {
    expect(() => {
      validateReviewResultAgainstPlan(plan, { schemaVersion: 1, findings: [] })
    }).toThrow('structured output schemaVersion 2 is required when a review plan exists')
  })

  it('sampledAccountIds は plan の重複 account を除いて plan 順に導出する', () => {
    expect(
      extractPlannedAccountIds({
        ...plan,
        samples: [
          { sampleId: 'l1:a1', accountId: 'a1' },
          { sampleId: 'l2:a1', accountId: 'a1' },
          { sampleId: 'l1:a2', accountId: 'a2' },
        ],
      }),
    ).toEqual(['a1', 'a2'])
  })
})
