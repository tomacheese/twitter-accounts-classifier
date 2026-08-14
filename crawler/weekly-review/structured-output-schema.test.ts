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

  it('v3 finding は解決状態を保持する', () => {
    const resolution = {
      status: 'fixed',
      summary: '回帰テストを追加して修正済み',
      evidenceReference: 'tests/rule-regression',
    }
    const parsed = structuredOutputSchema.parse({
      ...valid,
      schemaVersion: 3,
      findings: [
        {
          type: 'coverage_gap',
          dimensions: { labelKey: 'topic_test' },
          primaryScopeType: 'label',
          primaryScopeId: 'l1',
          confidence: 0.9,
          sampleCount: 1,
          sampleReference: ['a1'],
          evidenceReference: 'finding/1',
          structuredMeasurement: {},
          suggestedSeverity: 'medium',
          resolution,
        },
      ],
    })
    expect(parsed.findings[0]?.resolution).toEqual(resolution)
  })

  it('v3 finding に resolution がなければ拒否する', () => {
    expect(
      structuredOutputSchema.safeParse({
        ...valid,
        schemaVersion: 3,
        findings: [
          {
            type: 'coverage_gap',
            dimensions: { labelKey: 'topic_test' },
            primaryScopeType: 'label',
            primaryScopeId: 'l1',
            confidence: 0.9,
            sampleCount: 1,
            sampleReference: ['a1'],
            evidenceReference: 'finding/1',
            structuredMeasurement: {},
            suggestedSeverity: 'medium',
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('v3 の false_positive / false_negative judgment は fixed resolution が必須', () => {
    for (const verdict of ['false_positive', 'false_negative'] as const) {
      const unresolved = structuredOutputSchema.safeParse({
        ...valid,
        schemaVersion: 3,
        review: {
          ...valid.review,
          judgments: [{ ...valid.review.judgments[0], verdict }],
        },
      })
      expect(unresolved.success).toBe(false)

      const resolution = {
        status: 'fixed' as const,
        summary: '同じ run で修正済み',
        evidenceReference: 'tests/sample-regression',
      }
      const resolved = structuredOutputSchema.safeParse({
        ...valid,
        schemaVersion: 3,
        review: {
          ...valid.review,
          judgments: [{ ...valid.review.judgments[0], verdict, resolution }],
        },
      })
      expect(resolved.success).toBe(true)
      if (resolved.success)
        expect(resolved.data.review?.judgments[0]?.resolution).toEqual(resolution)
    }
  })

  it('v3 は deferred_to_issue resolution に理由と実在 Issue の参照情報を必須にする', () => {
    const finding = {
      type: 'coverage_gap',
      dimensions: { labelKey: 'topic_test' },
      primaryScopeType: 'label',
      primaryScopeId: 'l1',
      confidence: 0.9,
      sampleCount: 1,
      sampleReference: ['a1'],
      evidenceReference: 'finding/1',
      structuredMeasurement: {},
      suggestedSeverity: 'medium',
    }
    const deferred = {
      status: 'deferred_to_issue',
      summary: '人間の判断が必要なので Issue へ移管',
      evidenceReference: 'finding/1',
      deferReason: 'human_judgment_required',
      issueNumber: 203,
      issueUrl: 'https://github.com/tomacheese/twitter-accounts-classifier/issues/203',
    }

    expect(
      structuredOutputSchema.safeParse({
        ...valid,
        schemaVersion: 3,
        findings: [{ ...finding, resolution: deferred }],
      }).success,
    ).toBe(true)
    expect(
      structuredOutputSchema.safeParse({
        ...valid,
        schemaVersion: 3,
        findings: [{ ...finding, resolution: { ...deferred, issueUrl: undefined } }],
      }).success,
    ).toBe(false)
  })

  it('v3 の false_positive / false_negative judgment は fixed または deferred_to_issue を受理する', () => {
    for (const verdict of ['false_positive', 'false_negative'] as const) {
      const deferred = structuredOutputSchema.safeParse({
        ...valid,
        schemaVersion: 3,
        review: {
          ...valid.review,
          judgments: [
            {
              ...valid.review.judgments[0],
              verdict,
              resolution: {
                status: 'deferred_to_issue',
                summary: '修正範囲が大きいため Issue へ移管',
                evidenceReference: 'sample/1',
                deferReason: 'oversized_scope',
                issueNumber: 204,
                issueUrl: 'https://github.com/tomacheese/twitter-accounts-classifier/issues/204',
              },
            },
          ],
        },
      })
      expect(deferred.success).toBe(true)
    }
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
