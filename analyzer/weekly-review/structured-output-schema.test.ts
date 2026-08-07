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
})
