import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildLabelSummary } from './build-label-summary'

describe('buildLabelSummary', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.labelSummaryCurrent.deleteMany()
    await prisma.reviewFindingOccurrence.deleteMany()
    await prisma.reviewFinding.deleteMany()
    await prisma.labelMetricSnapshot.deleteMany()
    await prisma.labelDefinition.deleteMany()
  })

  it('最新 snapshot と active Finding 件数から LabelSummaryCurrent を作る', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    await prisma.labelMetricSnapshot.create({
      data: {
        sourceCrawlRunId: `crawl-${randomUUID()}`,
        labelDefinitionId: labelDefinition.id,
        observedAt: new Date(),
        sourceWatermarkAt: new Date(),
        evaluatedCount: 100,
        trueCount: 20,
        prevalence: 0.2,
        completeness: 'complete',
        policyHash: 'hash',
        analyzerVersion: '1',
      },
    })

    await prisma.reviewFinding.create({
      data: {
        fingerprint: `fingerprint-${randomUUID()}`,
        identityVersion: 1,
        type: 'label_count_drop',
        primaryScopeType: 'label',
        primaryScopeId: labelDefinition.id,
        status: 'active',
        currentSeverity: 'high',
        maximumSeverity: 'high',
      },
    })

    const generationId = `generation-${randomUUID()}`
    const result = await buildLabelSummary(prisma, { generationId, sourceWatermarkAt: new Date() })

    expect(result.rowCount).toBe(1)

    const rows = await prisma.labelSummaryCurrent.findMany({ where: { generationId } })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.trueCount).toBe(20)
    expect(rows[0]?.evaluatedCount).toBe(100)
    expect(rows[0]?.prevalence).toBeCloseTo(0.2)
    expect(rows[0]?.activeFindingCount).toBe(1)
    expect(rows[0]?.highestFindingSeverity).toBe('high')
    expect(rows[0]?.qualityStatus).toBe('attention')
  })

  it('snapshot が存在しない LabelDefinition は行を作らない', async () => {
    await prisma.labelDefinition.create({
      data: { key: `unused_label_${randomUUID()}`, description: 'snapshot なしラベル' },
    })

    const generationId = `generation-${randomUUID()}`
    const result = await buildLabelSummary(prisma, { generationId, sourceWatermarkAt: new Date() })

    expect(result.rowCount).toBe(0)
  })
})
