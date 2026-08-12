import { describe, expect, it, vi } from 'vitest'
import { computeConfidenceDiagnostics } from './compute-confidence-diagnostics'

function makeRun(overrides: { id: string; targetTo: Date; judgments: Record<string, unknown>[] }) {
  return {
    id: overrides.id,
    status: 'success',
    targetTo: overrides.targetTo,
    structuredOutput: {
      schemaVersion: 2,
      promptVersion: 'p1',
      specVersion: 's1',
      modelIdentity: 'm1',
      toolIdentity: 't1',
      repositoryCommit: 'c1',
      targetFrom: new Date('2026-01-01').toISOString(),
      targetTo: overrides.targetTo.toISOString(),
      sourceRunId: overrides.id,
      review: {
        strategyVersion: 'risk-stratified/2',
        seed: 'seed',
        budget: overrides.judgments.length,
        plannedSampleCount: overrides.judgments.length,
        reviewedSampleCount: overrides.judgments.length,
        randomAuditCount: overrides.judgments.length,
        targetedAuditCount: 0,
        uncertainCount: 0,
        skippedCount: 0,
        incompletePhases: [],
        judgments: overrides.judgments,
      },
      findings: [],
    },
  }
}

function makeJudgment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sampleId: `s-${Math.random()}`,
    accountId: 'a1',
    labelDefinitionId: 'l1',
    labelKey: 'label_one',
    sampleKind: 'random_positive',
    classifierValue: true,
    classifierConfidence: 0.85,
    ruleVersion: '1.0.0',
    verdict: 'correct',
    judgeConfidence: 0.9,
    evidenceReference: 'ref',
    reviewedBy: 'reviewer',
    populationCount: 10,
    classifierEvaluable: true,
    ...overrides,
  }
}

describe('computeConfidenceDiagnostics', () => {
  it('buckets confidence into 0.1-wide bins and computes a population-weighted correctness rate', async () => {
    const judgments = [
      ...Array.from({ length: 25 }, () =>
        makeJudgment({ classifierConfidence: 0.85, verdict: 'correct', populationCount: 4 }),
      ),
      ...Array.from({ length: 25 }, () =>
        makeJudgment({ classifierConfidence: 0.85, verdict: 'false_positive', populationCount: 4 }),
      ),
    ]
    const run = makeRun({ id: 'run-1', targetTo: new Date('2026-01-08'), judgments })
    const prisma = { weeklyAnalysisRun: { findMany: vi.fn().mockResolvedValue([run]) } }

    const result = await computeConfidenceDiagnostics(prisma as never, {})
    const cell = result.find(
      (c) => c.labelKey === 'label_one' && c.ruleVersion === '1.0.0' && c.classifierValue,
    )
    expect(cell).toBeDefined()
    const bin = cell?.bins.find((b) => b.binStart === 0.8)
    expect(bin?.n).toBe(50)
    expect(bin?.correctnessRate).toBeCloseTo(0.5, 5)
  })

  it('excludes uncertain/skipped verdicts and classifierEvaluable=false judgments', async () => {
    const judgments = [
      makeJudgment({ verdict: 'uncertain' }),
      makeJudgment({ verdict: 'skipped' }),
      makeJudgment({ classifierEvaluable: false }),
      makeJudgment({ sampleKind: 'insufficient_support', classifierEvaluable: false }),
    ]
    const run = makeRun({ id: 'run-1', targetTo: new Date('2026-01-08'), judgments })
    const prisma = { weeklyAnalysisRun: { findMany: vi.fn().mockResolvedValue([run]) } }

    const result = await computeConfidenceDiagnostics(prisma as never, {})
    expect(result).toEqual([])
  })

  it('excludes non random_positive/random_negative sample kinds', async () => {
    const judgments = [makeJudgment({ sampleKind: 'risk_targeted' })]
    const run = makeRun({ id: 'run-1', targetTo: new Date('2026-01-08'), judgments })
    const prisma = { weeklyAnalysisRun: { findMany: vi.fn().mockResolvedValue([run]) } }

    const result = await computeConfidenceDiagnostics(prisma as never, {})
    expect(result).toEqual([])
  })

  it('accumulates across multiple runs sharing the same ruleVersion (rolling window)', async () => {
    const runA = makeRun({
      id: 'run-a',
      targetTo: new Date('2026-01-08'),
      judgments: [makeJudgment({ verdict: 'correct' })],
    })
    const runB = makeRun({
      id: 'run-b',
      targetTo: new Date('2026-01-15'),
      judgments: [makeJudgment({ verdict: 'correct' })],
    })
    const prisma = {
      weeklyAnalysisRun: { findMany: vi.fn().mockResolvedValue([runA, runB]) },
    }

    const result = await computeConfidenceDiagnostics(prisma as never, {})
    const latestSnapshotForCell = result.findLast(
      (c) => c.labelKey === 'label_one' && c.ruleVersion === '1.0.0',
    )
    const bin = latestSnapshotForCell?.bins.find((b) => b.binStart === 0.8)
    expect(bin?.n).toBe(2)
  })

  it('resets accumulation when ruleVersion changes', async () => {
    const runA = makeRun({
      id: 'run-a',
      targetTo: new Date('2026-01-08'),
      judgments: [makeJudgment({ ruleVersion: '1.0.0' })],
    })
    const runB = makeRun({
      id: 'run-b',
      targetTo: new Date('2026-01-15'),
      judgments: [makeJudgment({ ruleVersion: '2.0.0' })],
    })
    const prisma = {
      weeklyAnalysisRun: { findMany: vi.fn().mockResolvedValue([runA, runB]) },
    }

    const result = await computeConfidenceDiagnostics(prisma as never, {})
    const v1Cells = result.filter((c) => c.ruleVersion === '1.0.0')
    const v2Cells = result.filter((c) => c.ruleVersion === '2.0.0')
    expect(v1Cells.every((c) => c.bins.every((b) => b.n <= 1))).toBe(true)
    expect(v2Cells.every((c) => c.bins.every((b) => b.n <= 1))).toBe(true)
  })

  it('marks bins with n_eff below MIN_DIAGNOSTIC_N_EFF as insufficient support instead of reporting a point estimate', async () => {
    const judgments = [makeJudgment({ populationCount: 1 })]
    const run = makeRun({ id: 'run-1', targetTo: new Date('2026-01-08'), judgments })
    const prisma = { weeklyAnalysisRun: { findMany: vi.fn().mockResolvedValue([run]) } }

    const result = await computeConfidenceDiagnostics(prisma as never, {})
    const bin = result[0]?.bins.find((b) => b.binStart === 0.8)
    expect(bin?.insufficientSupport).toBe(true)
    expect(bin?.correctnessRate).toBeUndefined()
    expect(bin?.brierScore).toBeUndefined()
  })

  it('falls back to a weight of 1 when populationCount is missing', async () => {
    const judgments = [makeJudgment({ populationCount: undefined })]
    const run = makeRun({ id: 'run-1', targetTo: new Date('2026-01-08'), judgments })
    const prisma = { weeklyAnalysisRun: { findMany: vi.fn().mockResolvedValue([run]) } }

    const result = await computeConfidenceDiagnostics(prisma as never, {})
    const bin = result[0]?.bins.find((b) => b.binStart === 0.8)
    expect(bin?.n).toBe(1)
  })
})
