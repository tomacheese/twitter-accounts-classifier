import { describe, it, expect } from 'vitest'
import { structuredOutputSchema } from './structured-output-schema'

const validOutput = {
  schemaVersion: 1,
  promptVersion: 'v1',
  specVersion: 'v1',
  modelIdentity: 'claude-test',
  toolIdentity: 'weekly-review-cli',
  repositoryCommit: 'abc1234',
  targetFrom: '2026-08-01T00:00:00Z',
  targetTo: '2026-08-07T00:00:00Z',
  sourceRunId: 'weekly-run-1',
  findings: [
    {
      type: 'possible_false_positive',
      dimensions: { label: 'test_label' },
      primaryScopeType: 'account',
      primaryScopeId: 'account-1',
      confidence: 0.6,
      sampleCount: 3,
      sampleReference: ['account-1', 'account-2'],
      evidenceReference: 'weekly-run-1/finding-1',
      structuredMeasurement: { note: 'sample note' },
      suggestedSeverity: 'medium',
    },
  ],
}

const validV2Output = {
  ...validOutput,
  schemaVersion: 2,
  promptVersion: 'weekly-crawl-review/2',
  review: {
    strategyVersion: 'risk-stratified/1',
    seed: 'weekly-run-1',
    budget: 240,
    plannedSampleCount: 2,
    reviewedSampleCount: 2,
    randomAuditCount: 1,
    targetedAuditCount: 1,
    uncertainCount: 1,
    skippedCount: 0,
    incompletePhases: [],
    judgments: [
      {
        sampleId: 'label-1:account-1',
        accountId: 'account-1',
        labelDefinitionId: 'label-1',
        labelKey: 'topic_test',
        sampleKind: 'random_positive',
        classifierValue: true,
        classifierConfidence: 0.8,
        ruleVersion: '1.0.0',
        verdict: 'correct',
        judgeConfidence: 0.9,
        evidenceReference: 'sample/1',
        reviewedBy: 'weekly-review-judge',
      },
      {
        sampleId: 'label-1:account-2',
        accountId: 'account-2',
        labelDefinitionId: 'label-1',
        labelKey: 'topic_test',
        sampleKind: 'high_confidence_negative',
        classifierValue: false,
        classifierConfidence: 0.7,
        ruleVersion: '1.0.0',
        verdict: 'uncertain',
        judgeConfidence: 0.4,
        evidenceReference: 'sample/2',
        reviewedBy: 'weekly-review-judge',
        unavailableReason: 'context is insufficient',
      },
    ],
  },
}

describe('structuredOutputSchema', () => {
  it('必須項目が揃っていれば受理する', () => {
    const result = structuredOutputSchema.safeParse(validOutput)
    expect(result.success).toBe(true)
  })

  it('schemaVersion が欠けていれば reject する', () => {
    const rest: Record<string, unknown> = { ...validOutput }
    delete rest.schemaVersion
    const result = structuredOutputSchema.safeParse(rest)
    expect(result.success).toBe(false)
  })

  it('finding の suggestedSeverity が不正な値なら reject する', () => {
    const result = structuredOutputSchema.safeParse({
      ...validOutput,
      findings: [{ ...validOutput.findings[0], suggestedSeverity: 'unknown' }],
    })
    expect(result.success).toBe(false)
  })

  it('finding の confidence が範囲外なら reject する', () => {
    const result = structuredOutputSchema.safeParse({
      ...validOutput,
      findings: [{ ...validOutput.findings[0], confidence: 1.5 }],
    })
    expect(result.success).toBe(false)
  })

  it('unavailableReason は任意項目として受理する', () => {
    const result = structuredOutputSchema.safeParse({
      ...validOutput,
      findings: [
        {
          ...validOutput.findings[0],
          unavailableReason: 'サンプル不足のため確度を計算できなかった',
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('schemaVersion 2 は review ledger が揃っていれば受理する', () => {
    expect(structuredOutputSchema.safeParse(validV2Output).success).toBe(true)
  })

  it('schemaVersion 2 で review が無ければ reject する', () => {
    expect(structuredOutputSchema.safeParse({ ...validV2Output, review: undefined }).success).toBe(
      false,
    )
  })

  it('review 集計値が judgments と一致しなければ reject する', () => {
    const result = structuredOutputSchema.safeParse({
      ...validV2Output,
      review: { ...validV2Output.review, reviewedSampleCount: 1 },
    })
    expect(result.success).toBe(false)
  })

  it('同じ sampleId が複数 judgment にあれば reject する', () => {
    const result = structuredOutputSchema.safeParse({
      ...validV2Output,
      review: {
        ...validV2Output.review,
        judgments: [validV2Output.review.judgments[0], validV2Output.review.judgments[0]],
      },
    })
    expect(result.success).toBe(false)
  })
})
