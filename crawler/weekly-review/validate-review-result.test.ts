import { describe, expect, it } from 'vitest'
import { extractPlannedAccountIds, validateReviewResultAgainstPlan } from './validate-review-result'

interface TestJudgment {
  sampleId: string
  verdict: string
  resolution?: { status: string }
}

interface TestFinding {
  type: string
  resolution?: { status: string }
}

interface TestResult {
  schemaVersion: number
  review: {
    strategyVersion: string
    seed: string
    plannedSampleCount: number
    incompletePhases: string[]
    judgments: TestJudgment[]
  }
  findings: TestFinding[]
}

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

function result(sampleIds: string[]): TestResult {
  return {
    schemaVersion: 3,
    review: {
      strategyVersion: 'risk-stratified/1',
      seed: 'run-1',
      plannedSampleCount: sampleIds.length,
      incompletePhases: [],
      judgments: sampleIds.map((sampleId) => ({ sampleId, verdict: 'correct' })),
    },
    findings: [],
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

  it('plan が存在する run では structured output v3 を必須にする', () => {
    expect(() => {
      validateReviewResultAgainstPlan(plan, { ...result(['l1:a1', 'l1:a2']), schemaVersion: 2 })
    }).toThrow('structured output schemaVersion 3 is required when a review plan exists')
  })

  it('uncertain または skipped judgment が残っていれば complete を拒否する', () => {
    for (const verdict of ['uncertain', 'skipped']) {
      const current = result(['l1:a1', 'l1:a2'])
      current.review.judgments[0] = { sampleId: 'l1:a1', verdict }
      expect(() => {
        validateReviewResultAgainstPlan(plan, current)
      }).toThrow('review result contains unresolved sample judgments')
    }
  })

  it('false_positive / false_negative judgment は fixed resolution が必須', () => {
    for (const verdict of ['false_positive', 'false_negative']) {
      const unresolved = result(['l1:a1', 'l1:a2'])
      unresolved.review.judgments[0] = { sampleId: 'l1:a1', verdict }
      expect(() => {
        validateReviewResultAgainstPlan(plan, unresolved)
      }).toThrow('review result contains unresolved sample judgments')

      const resolved = result(['l1:a1', 'l1:a2'])
      resolved.review.judgments[0] = {
        sampleId: 'l1:a1',
        verdict,
        resolution: { status: 'fixed' },
      }
      expect(() => {
        validateReviewResultAgainstPlan(plan, resolved)
      }).not.toThrow()
    }
  })

  it('incomplete phase が残っていれば complete を拒否する', () => {
    const current = result(['l1:a1', 'l1:a2'])
    current.review.incompletePhases = ['external_research']
    expect(() => {
      validateReviewResultAgainstPlan(plan, current)
    }).toThrow('review result contains incomplete phases')
  })

  it('resolution のない finding が残っていれば complete を拒否する', () => {
    const current = result(['l1:a1', 'l1:a2'])
    current.findings = [{ type: 'coverage_gap' }]
    expect(() => {
      validateReviewResultAgainstPlan(plan, current)
    }).toThrow('review result contains unresolved findings')
  })

  it('finding が fixed または verified_not_issue なら complete を受理する', () => {
    const current = result(['l1:a1', 'l1:a2'])
    current.findings = [
      { type: 'coverage_gap', resolution: { status: 'fixed' } },
      { type: 'rule_behavior_mismatch', resolution: { status: 'verified_not_issue' } },
    ]
    expect(() => {
      validateReviewResultAgainstPlan(plan, current)
    }).not.toThrow()
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
