import { describe, expect, it } from 'vitest'
import {
  structuredOutputSchema,
  weeklyReviewSampleJudgmentSchema,
} from './structured-output-schema'

const valid = {
  schemaVersion: 2,
  promptVersion: 'weekly-crawl-review/2',
  specVersion: '2',
  modelIdentity: 'claude-test',
  toolIdentity: 'claude-code',
  repositoryCommit: 'abc123',
  targetFrom: '2026-08-05T00:00:00Z',
  targetTo: '2026-08-12T00:00:00Z',
  sourceRunId: 'run-1',
  review: {
    strategyVersion: 'risk-stratified/2',
    seed: 'run-1',
    budget: 240,
    plannedSampleCount: 1,
    reviewedSampleCount: 1,
    randomAuditCount: 1,
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
    ],
  },
  findings: [],
}

describe('crawler structuredOutputSchema', () => {
  it('v2 ledger を受理する', () => {
    expect(structuredOutputSchema.safeParse(valid).success).toBe(true)
  })

  it('judgment 集計と count がずれていれば拒否する', () => {
    expect(
      structuredOutputSchema.safeParse({
        ...valid,
        review: { ...valid.review, reviewedSampleCount: 0 },
      }).success,
    ).toBe(false)
  })

  it('v2 で review が無ければ拒否する', () => {
    expect(structuredOutputSchema.safeParse({ ...valid, review: undefined }).success).toBe(false)
  })

  it('populationCount・classifierEvaluable を持つ新しい sampleKind を受理する', () => {
    const judgment = {
      sampleId: 's1',
      accountId: 'a1',
      labelDefinitionId: 'l1',
      labelKey: 'label_one',
      sampleKind: 'positive_evidence_negative',
      classifierValue: false,
      classifierConfidence: 0.3,
      ruleVersion: '1.0.0',
      verdict: 'correct',
      judgeConfidence: 0.9,
      evidenceReference: 'ref',
      reviewedBy: 'reviewer',
      populationCount: 100,
      classifierEvaluable: true,
    }
    expect(weeklyReviewSampleJudgmentSchema.safeParse(judgment).success).toBe(true)
    expect(
      weeklyReviewSampleJudgmentSchema.safeParse({
        ...judgment,
        sampleKind: 'insufficient_support',
      }).success,
    ).toBe(true)
  })

  it('旧 high_confidence_negative sampleKind を後方互換として受理する', () => {
    const judgment = {
      sampleId: 's1',
      accountId: 'a1',
      labelDefinitionId: 'l1',
      labelKey: 'label_one',
      sampleKind: 'high_confidence_negative',
      classifierValue: false,
      classifierConfidence: 1,
      ruleVersion: '1.0.0',
      verdict: 'correct',
      judgeConfidence: 0.9,
      evidenceReference: 'ref',
      reviewedBy: 'reviewer',
    }
    expect(weeklyReviewSampleJudgmentSchema.safeParse(judgment).success).toBe(true)
  })
})
