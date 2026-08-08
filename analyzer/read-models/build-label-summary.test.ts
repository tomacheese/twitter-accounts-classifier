import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildLabelSummary } from './build-label-summary'

describe.skipIf(!process.env.DATABASE_URL)('buildLabelSummary', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.labelSummaryCurrent.deleteMany()
    await prisma.findingEvidence.deleteMany()
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

  it('completeness が unknown の snapshot は最新値としても比較対象としても使わない', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    const now = Date.now()
    await prisma.labelMetricSnapshot.createMany({
      data: [
        {
          sourceCrawlRunId: `crawl-${randomUUID()}`,
          labelDefinitionId: labelDefinition.id,
          observedAt: new Date(now),
          sourceWatermarkAt: new Date(now),
          evaluatedCount: 0,
          trueCount: 0,
          prevalence: 0,
          completeness: 'unknown',
          policyHash: 'hash',
          analyzerVersion: '1',
        },
        {
          sourceCrawlRunId: `crawl-${randomUUID()}`,
          labelDefinitionId: labelDefinition.id,
          observedAt: new Date(now - 60 * 60 * 1000),
          sourceWatermarkAt: new Date(now - 60 * 60 * 1000),
          evaluatedCount: 100,
          trueCount: 20,
          prevalence: 0.2,
          completeness: 'complete',
          policyHash: 'hash',
          analyzerVersion: '1',
        },
      ],
    })

    const generationId = `generation-${randomUUID()}`
    await buildLabelSummary(prisma, { generationId, sourceWatermarkAt: new Date() })

    const rows = await prisma.labelSummaryCurrent.findMany({ where: { generationId } })
    expect(rows[0]?.prevalence).toBeCloseTo(0.2)
    expect(rows[0]?.evaluatedCount).toBe(100)
  })

  it('completeness が partial の snapshot は最新値としても比較対象としても使わない', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    const now = Date.now()
    await prisma.labelMetricSnapshot.createMany({
      data: [
        {
          sourceCrawlRunId: `crawl-${randomUUID()}`,
          labelDefinitionId: labelDefinition.id,
          observedAt: new Date(now),
          sourceWatermarkAt: new Date(now),
          evaluatedCount: 40,
          trueCount: 30,
          prevalence: 0.75,
          completeness: 'partial',
          policyHash: 'hash',
          analyzerVersion: '1',
        },
        {
          sourceCrawlRunId: `crawl-${randomUUID()}`,
          labelDefinitionId: labelDefinition.id,
          observedAt: new Date(now - 60 * 60 * 1000),
          sourceWatermarkAt: new Date(now - 60 * 60 * 1000),
          evaluatedCount: 100,
          trueCount: 20,
          prevalence: 0.2,
          completeness: 'complete',
          policyHash: 'hash',
          analyzerVersion: '1',
        },
      ],
    })

    const generationId = `generation-${randomUUID()}`
    await buildLabelSummary(prisma, { generationId, sourceWatermarkAt: new Date() })

    const rows = await prisma.labelSummaryCurrent.findMany({ where: { generationId } })
    expect(rows[0]?.prevalence).toBeCloseTo(0.2)
    expect(rows[0]?.evaluatedCount).toBe(100)
  })

  it('crawl 間隔に依らず 24 時間前・7 日前の snapshot と比較する', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const offsets = [0, 1 * day, 8 * day]
    const prevalences = [0.4, 0.3, 0.1]
    await prisma.labelMetricSnapshot.createMany({
      data: offsets.map((offset, index) => ({
        sourceCrawlRunId: `crawl-${randomUUID()}`,
        labelDefinitionId: labelDefinition.id,
        observedAt: new Date(now - offset),
        sourceWatermarkAt: new Date(now - offset),
        evaluatedCount: 100,
        trueCount: prevalences[index] * 100,
        prevalence: prevalences[index],
        completeness: 'complete',
        policyHash: 'hash',
        analyzerVersion: '1',
      })),
    })

    const generationId = `generation-${randomUUID()}`
    await buildLabelSummary(prisma, { generationId, sourceWatermarkAt: new Date() })

    const rows = await prisma.labelSummaryCurrent.findMany({ where: { generationId } })
    expect(rows[0]?.dayDelta).toBeCloseTo(0.1)
    expect(rows[0]?.weekDelta).toBeCloseTo(0.3)
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
