import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { runBacktest } from './run-backtest'
import type { DetectionPolicy } from '../policy/schema'

const prisma = getPrismaClient()

/**
 * @param labelDefinitionId - snapshot の対象ラベル
 * @returns 直前 snapshot に対し 20% の低下となる 2 件の snapshot
 */
async function seedSnapshots(labelDefinitionId: string): Promise<void> {
  const crawlRunA = `crawl-${randomUUID()}`
  const crawlRunB = `crawl-${randomUUID()}`
  await prisma.labelMetricSnapshot.create({
    data: {
      sourceCrawlRunId: crawlRunA,
      labelDefinitionId,
      observedAt: new Date('2026-08-01T00:00:00Z'),
      sourceWatermarkAt: new Date('2026-08-01T00:00:00Z'),
      evaluatedCount: 100,
      trueCount: 100,
      prevalence: 1,
      completeness: 'complete',
      policyHash: 'seed',
      analyzerVersion: '1',
    },
  })
  await prisma.labelMetricSnapshot.create({
    data: {
      sourceCrawlRunId: crawlRunB,
      labelDefinitionId,
      observedAt: new Date('2026-08-02T00:00:00Z'),
      sourceWatermarkAt: new Date('2026-08-02T00:00:00Z'),
      evaluatedCount: 100,
      trueCount: 80,
      prevalence: 0.8,
      completeness: 'complete',
      policyHash: 'seed',
      analyzerVersion: '1',
    },
  })
}

/**
 * @param relativeThreshold - label_count_drop の相対しきい値
 * @returns テスト用の policy
 */
function buildPolicy(relativeThreshold: number): DetectionPolicy {
  return {
    schemaVersion: 1,
    policyVersion: `test-${relativeThreshold}`,
    rules: [
      {
        type: 'label_count_drop',
        enabled: true,
        detectorType: 'comparative',
        identityVersion: 1,
        severity: 'high',
        relativeThreshold,
        minimumSampleSize: 10,
        activationCount: 1,
        resolutionCount: 1,
        criticalImmediate: false,
      },
    ],
  }
}

describe('runBacktest', () => {
  beforeEach(async () => {
    await prisma.policyBacktestFinding.deleteMany()
    await prisma.policyBacktestRun.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
    await prisma.labelMetricSnapshot.deleteMany()
  })

  it('backtest 実行中に ReviewFinding テーブルへは一切書き込まれない', async () => {
    const labelDefinitionId = `label-${randomUUID()}`
    await seedSnapshots(labelDefinitionId)

    await runBacktest(prisma, {
      targetFrom: new Date('2026-08-01T00:00:00Z'),
      targetTo: new Date('2026-08-03T00:00:00Z'),
      labelDefinitionIds: [labelDefinitionId],
      candidatePolicy: buildPolicy(0.1),
      baselinePolicy: buildPolicy(0.5),
    })

    const findings = await prisma.reviewFinding.findMany()
    expect(findings).toHaveLength(0)
  })

  it('candidatePolicy だけが検出する差分を new_in_candidate として記録する', async () => {
    const labelDefinitionId = `label-${randomUUID()}`
    await seedSnapshots(labelDefinitionId)

    const runId = await runBacktest(prisma, {
      targetFrom: new Date('2026-08-01T00:00:00Z'),
      targetTo: new Date('2026-08-03T00:00:00Z'),
      labelDefinitionIds: [labelDefinitionId],
      candidatePolicy: buildPolicy(0.1),
      baselinePolicy: buildPolicy(0.5),
    })

    const findings = await prisma.policyBacktestFinding.findMany({ where: { runId } })
    expect(findings).toHaveLength(1)
    expect(findings[0]?.diffKind).toBe('new_in_candidate')
  })

  it('同一入力・同一 policyHash で 2 回実行すると同じ PolicyBacktestFinding 件数になる', async () => {
    const labelDefinitionId = `label-${randomUUID()}`
    await seedSnapshots(labelDefinitionId)

    const input = {
      targetFrom: new Date('2026-08-01T00:00:00Z'),
      targetTo: new Date('2026-08-03T00:00:00Z'),
      labelDefinitionIds: [labelDefinitionId],
      candidatePolicy: buildPolicy(0.1),
      baselinePolicy: buildPolicy(0.5),
    }

    const runIdA = await runBacktest(prisma, input)
    const runIdB = await runBacktest(prisma, input)

    const findingsA = await prisma.policyBacktestFinding.findMany({ where: { runId: runIdA } })
    const findingsB = await prisma.policyBacktestFinding.findMany({ where: { runId: runIdB } })
    expect(findingsA).toHaveLength(findingsB.length)
  })
})
