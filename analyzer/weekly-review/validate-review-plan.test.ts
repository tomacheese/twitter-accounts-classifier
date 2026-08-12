import { describe, expect, it } from 'vitest'
import type { StructuredOutput } from './structured-output-schema'
import { validateStructuredOutputAgainstReviewPlan } from './validate-review-plan'

const plan = {
  strategyVersion: 'risk-stratified/1',
  seed: 'run-1',
  samples: [{ sampleId: 'l1:a1' }, { sampleId: 'l1:a2' }],
}

const output: StructuredOutput = {
  schemaVersion: 2,
  promptVersion: 'weekly-crawl-review/2',
  specVersion: '2',
  modelIdentity: 'claude-test',
  toolIdentity: 'claude-code',
  repositoryCommit: 'abc123',
  targetFrom: new Date('2026-08-05T00:00:00Z'),
  targetTo: new Date('2026-08-12T00:00:00Z'),
  sourceRunId: 'run-1',
  review: {
    strategyVersion: 'risk-stratified/1',
    seed: 'run-1',
    budget: 240,
    plannedSampleCount: 2,
    reviewedSampleCount: 2,
    randomAuditCount: 2,
    targetedAuditCount: 0,
    uncertainCount: 0,
    skippedCount: 0,
    incompletePhases: [],
    judgments: [
      {
        sampleId: 'l1:a1',
        accountId: 'a1',
        labelDefinitionId: 'l1',
        labelKey: 'topic_test',
        sampleKind: 'random_positive',
        classifierValue: true,
        classifierConfidence: 0.8,
        ruleVersion: '1.0.0',
        verdict: 'correct',
        judgeConfidence: 0.9,
        evidenceReference: 'sample/1',
        reviewedBy: 'judge',
      },
      {
        sampleId: 'l1:a2',
        accountId: 'a2',
        labelDefinitionId: 'l1',
        labelKey: 'topic_test',
        sampleKind: 'random_negative',
        classifierValue: false,
        classifierConfidence: 0,
        ruleVersion: '1.0.0',
        verdict: 'correct',
        judgeConfidence: 0.9,
        evidenceReference: 'sample/2',
        reviewedBy: 'judge',
      },
    ],
  },
  findings: [],
}

describe('validateStructuredOutputAgainstReviewPlan', () => {
  it('identity と sample coverage が一致すれば受理する', () => {
    expect(() => {
      validateStructuredOutputAgainstReviewPlan(plan, output)
    }).not.toThrow()
  })

  it('sample が欠けていれば拒否する', () => {
    const review = output.review
    if (!review) throw new Error('test fixture review is required')
    const shortened = {
      ...output,
      review: {
        ...review,
        judgments: review.judgments.slice(0, 1),
      },
    } as StructuredOutput

    expect(() => {
      validateStructuredOutputAgainstReviewPlan(plan, shortened)
    }).toThrow('weekly review plan coverage mismatch')
  })

  it('v1 output は plan が存在する run では拒否する', () => {
    expect(() => {
      validateStructuredOutputAgainstReviewPlan(plan, {
        ...output,
        schemaVersion: 1,
        review: undefined,
      })
    }).toThrow('weekly review plan requires structured output v2')
  })
})
