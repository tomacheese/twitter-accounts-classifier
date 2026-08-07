import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { ingestWeeklyReviewFindings } from './ingest'
import type { DetectionPolicy } from '../policy/schema'
import type { StructuredOutput } from './structured-output-schema'

const loggerWarn = vi.fn()

vi.mock('@book000/node-utils', () => ({
  Logger: {
    configure: () => ({
      warn: (...args: unknown[]): unknown => loggerWarn(...args) as unknown,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  },
}))

const prisma = getPrismaClient()

const policy: DetectionPolicy = {
  schemaVersion: 1,
  policyVersion: 'test',
  rules: [
    {
      type: 'possible_false_positive',
      enabled: true,
      detectorType: 'weekly_review',
      identityVersion: 1,
      severity: 'medium',
      activationCount: 1,
      resolutionCount: 1,
      criticalImmediate: false,
      maxWeeklyReviewSeverityWithoutCorroboration: 'medium',
    },
  ],
}

/**
 * @param overrides - candidate へ上書きするフィールド
 * @returns テスト用の structuredOutput
 */
function buildStructuredOutput(
  overrides: Partial<StructuredOutput['findings'][number]>,
): StructuredOutput {
  return {
    schemaVersion: 1,
    promptVersion: 'v1',
    specVersion: 'v1',
    modelIdentity: 'claude-test',
    toolIdentity: 'weekly-review-cli',
    repositoryCommit: 'abc1234',
    targetFrom: new Date('2026-08-01T00:00:00Z'),
    targetTo: new Date('2026-08-07T00:00:00Z'),
    sourceRunId: 'weekly-run-1',
    findings: [
      {
        type: 'possible_false_positive',
        dimensions: { label: `test_label_${randomUUID()}` },
        primaryScopeType: 'account',
        primaryScopeId: 'account-1',
        confidence: 0.6,
        sampleCount: 3,
        sampleReference: ['account-1'],
        evidenceReference: 'weekly-run-1/finding-1',
        structuredMeasurement: { note: 'sample note' },
        suggestedSeverity: 'medium',
        ...overrides,
      },
    ],
  }
}

describe('ingestWeeklyReviewFindings', () => {
  beforeEach(async () => {
    await prisma.findingEvidence.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
  })

  it('同一 fingerprint の既存 active Finding がある場合、新規 Finding を作らず Occurrence と Evidence を追加する', async () => {
    const structuredOutput = buildStructuredOutput({})
    const dimensions = structuredOutput.findings[0]?.dimensions ?? {}

    await ingestWeeklyReviewFindings(prisma, {
      weeklyAnalysisRunId: `weekly-${randomUUID()}`,
      structuredOutput,
      policy,
    })
    const findingsAfterFirst = await prisma.reviewFinding.findMany({
      where: { type: 'possible_false_positive', primaryScopeId: 'account-1' },
    })
    expect(findingsAfterFirst).toHaveLength(1)

    await ingestWeeklyReviewFindings(prisma, {
      weeklyAnalysisRunId: `weekly-${randomUUID()}`,
      structuredOutput: buildStructuredOutput({ dimensions }),
      policy,
    })

    const findingsAfterSecond = await prisma.reviewFinding.findMany({
      where: { type: 'possible_false_positive', primaryScopeId: 'account-1' },
    })
    expect(findingsAfterSecond).toHaveLength(1)

    const occurrences = await prisma.reviewFindingOccurrence.findMany({
      where: { findingId: findingsAfterSecond[0]?.id },
    })
    expect(occurrences).toHaveLength(2)

    const evidences = await prisma.findingEvidence.findMany({
      where: { findingId: findingsAfterSecond[0]?.id },
    })
    expect(evidences).toHaveLength(2)
  })

  it('suggestedSeverity が critical でも maxWeeklyReviewSeverityWithoutCorroboration を超える場合は降格する', async () => {
    const structuredOutput = buildStructuredOutput({ suggestedSeverity: 'critical' })

    await ingestWeeklyReviewFindings(prisma, {
      weeklyAnalysisRunId: `weekly-${randomUUID()}`,
      structuredOutput,
      policy,
    })

    const finding = await prisma.reviewFinding.findFirstOrThrow({
      where: { type: 'possible_false_positive', primaryScopeId: 'account-1' },
    })
    expect(finding.currentSeverity).toBe('medium')
  })

  it('裏付け (既存 Occurrence) がある場合は critical まで昇格できる', async () => {
    const dimensions = { label: `test_label_${randomUUID()}` }

    await ingestWeeklyReviewFindings(prisma, {
      weeklyAnalysisRunId: `weekly-${randomUUID()}`,
      structuredOutput: buildStructuredOutput({ dimensions, suggestedSeverity: 'medium' }),
      policy,
    })
    await ingestWeeklyReviewFindings(prisma, {
      weeklyAnalysisRunId: `weekly-${randomUUID()}`,
      structuredOutput: buildStructuredOutput({ dimensions, suggestedSeverity: 'critical' }),
      policy,
    })

    const finding = await prisma.reviewFinding.findFirstOrThrow({
      where: { type: 'possible_false_positive', primaryScopeId: 'account-1' },
    })
    expect(finding.currentSeverity).toBe('critical')
  })

  it('unavailableReason が設定された candidate は取り込まない', async () => {
    const structuredOutput = buildStructuredOutput({
      unavailableReason: 'サンプル不足のため確度を計算できなかった',
    })

    await ingestWeeklyReviewFindings(prisma, {
      weeklyAnalysisRunId: `weekly-${randomUUID()}`,
      structuredOutput,
      policy,
    })

    const findings = await prisma.reviewFinding.findMany({
      where: { type: 'possible_false_positive', primaryScopeId: 'account-1' },
    })
    expect(findings).toHaveLength(0)
  })

  it('有効な policy rule が無い type の candidate は警告を出して取り込まない', async () => {
    loggerWarn.mockClear()
    const structuredOutput = buildStructuredOutput({ type: 'unknown_finding_type' })

    await ingestWeeklyReviewFindings(prisma, {
      weeklyAnalysisRunId: `weekly-${randomUUID()}`,
      structuredOutput,
      policy,
    })

    const findings = await prisma.reviewFinding.findMany({
      where: { type: 'unknown_finding_type' },
    })
    expect(findings).toHaveLength(0)
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringContaining('unknown_finding_type') as unknown as string,
    )
  })

  it('resolved 後に再発した Finding は recurring として永続化する', async () => {
    const dimensions = { label: `test_label_${randomUUID()}` }
    const recurringPolicy: DetectionPolicy = {
      ...policy,
      rules: policy.rules.map((rule) => ({ ...rule, recurrenceWindow: 'P30D' })),
    }

    await ingestWeeklyReviewFindings(prisma, {
      weeklyAnalysisRunId: `weekly-${randomUUID()}`,
      structuredOutput: buildStructuredOutput({ dimensions }),
      policy: recurringPolicy,
    })
    const created = await prisma.reviewFinding.findFirstOrThrow({
      where: { type: 'possible_false_positive', primaryScopeId: 'account-1' },
    })
    await prisma.reviewFinding.update({
      where: { id: created.id },
      data: { status: 'resolved', resolvedAt: new Date() },
    })

    await ingestWeeklyReviewFindings(prisma, {
      weeklyAnalysisRunId: `weekly-${randomUUID()}`,
      structuredOutput: buildStructuredOutput({ dimensions }),
      policy: recurringPolicy,
    })

    const updated = await prisma.reviewFinding.findUniqueOrThrow({ where: { id: created.id } })
    expect(updated.status).toBe('recurring')
    expect(updated.recurrenceCount).toBe(1)
  })
})
