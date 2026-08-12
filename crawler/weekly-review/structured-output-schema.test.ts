import { describe, expect, it } from 'vitest'
import { structuredOutputSchema } from './structured-output-schema'

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
    strategyVersion: 'risk-stratified/1',
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
})
