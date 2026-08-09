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
    const triggerWorkItemId = `work_item_${randomUUID()}`

    await prisma.labelMetricSnapshot.create({
      data: {
        triggerWorkItemId,
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
    const result = await buildLabelSummary(prisma, {
      generationId,
      triggerWorkItemId,
      sourceWatermarkAt: new Date(),
    })

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

  it('LabelMetricSnapshot の populationCount/coverage を LabelSummaryCurrent へコピーする', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })
    const triggerWorkItemId = `work_item_${randomUUID()}`

    await prisma.labelMetricSnapshot.create({
      data: {
        triggerWorkItemId,
        labelDefinitionId: labelDefinition.id,
        observedAt: new Date(),
        sourceWatermarkAt: new Date(),
        evaluatedCount: 80,
        trueCount: 8,
        populationCount: 100,
        coverage: 0.8,
        prevalence: 0.1,
        completeness: 'complete',
        policyHash: 'hash',
        analyzerVersion: '1',
      },
    })

    const generationId = `generation-${randomUUID()}`
    await buildLabelSummary(prisma, {
      generationId,
      triggerWorkItemId,
      sourceWatermarkAt: new Date(),
    })

    const rows = await prisma.labelSummaryCurrent.findMany({ where: { generationId } })
    expect(rows[0]?.populationCount).toBe(100)
    expect(rows[0]?.coverage).toBeCloseTo(0.8)
  })

  it('builds from the current triggerWorkItemId snapshot set without falling back to an old complete snapshot', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_summary_label_${randomUUID()}`, description: 'ラベル' },
    })

    await prisma.labelMetricSnapshot.create({
      data: {
        triggerWorkItemId: 'work_item_old',
        labelDefinitionId: labelDefinition.id,
        observedAt: new Date('2026-01-01T00:00:00Z'),
        sourceWatermarkAt: new Date('2026-01-01T00:00:00Z'),
        evaluatedCount: 100,
        trueCount: 10,
        prevalence: 0.1,
        completeness: 'complete',
        policyHash: 'hash',
        analyzerVersion: 'test',
      },
    })
    await prisma.labelMetricSnapshot.create({
      data: {
        triggerWorkItemId: 'work_item_new',
        labelDefinitionId: labelDefinition.id,
        observedAt: new Date('2026-01-02T00:00:00Z'),
        sourceWatermarkAt: new Date('2026-01-02T00:00:00Z'),
        evaluatedCount: 100,
        trueCount: 20,
        prevalence: 0.2,
        completeness: 'partial',
        policyHash: 'hash',
        analyzerVersion: 'test',
      },
    })

    const result = await buildLabelSummary(prisma, {
      generationId: 'gen_1',
      triggerWorkItemId: 'work_item_new',
      sourceWatermarkAt: new Date('2026-01-02T00:00:00Z'),
    })
    expect(result.rowCount).toBe(1)

    const row = await prisma.labelSummaryCurrent.findUnique({
      where: {
        generationId_labelDefinitionId: {
          generationId: 'gen_1',
          labelDefinitionId: labelDefinition.id,
        },
      },
    })
    expect(row?.qualityStatus).toBe('watch')
    expect(row?.previousRunDelta).toBeNull()
  })

  it('completeness が unknown の今回 snapshot は unknown のまま採用し、過去の complete snapshot へフォールバックしない', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    await prisma.labelMetricSnapshot.create({
      data: {
        triggerWorkItemId: 'work_item_unknown_old',
        sourceCrawlRunId: `crawl-${randomUUID()}`,
        labelDefinitionId: labelDefinition.id,
        observedAt: new Date(Date.now() - 60 * 60 * 1000),
        sourceWatermarkAt: new Date(Date.now() - 60 * 60 * 1000),
        evaluatedCount: 100,
        trueCount: 20,
        prevalence: 0.2,
        completeness: 'complete',
        policyHash: 'hash',
        analyzerVersion: '1',
      },
    })
    await prisma.labelMetricSnapshot.create({
      data: {
        triggerWorkItemId: 'work_item_unknown_current',
        sourceCrawlRunId: `crawl-${randomUUID()}`,
        labelDefinitionId: labelDefinition.id,
        observedAt: new Date(),
        sourceWatermarkAt: new Date(),
        evaluatedCount: 0,
        trueCount: 0,
        prevalence: 0,
        completeness: 'unknown',
        policyHash: 'hash',
        analyzerVersion: '1',
      },
    })

    const generationId = `generation-${randomUUID()}`
    await buildLabelSummary(prisma, {
      generationId,
      triggerWorkItemId: 'work_item_unknown_current',
      sourceWatermarkAt: new Date(),
    })

    const rows = await prisma.labelSummaryCurrent.findMany({ where: { generationId } })
    expect(rows[0]?.evaluatedCount).toBe(0)
    expect(rows[0]?.qualityStatus).toBe('unknown')
    expect(rows[0]?.previousRunDelta).toBeNull()
  })

  it('crawl 間隔に依らず 24 時間前・7 日前の snapshot と比較する', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const offsets = [0, 1 * day, 8 * day]
    const prevalences = [0.4, 0.3, 0.1]
    const currentTriggerWorkItemId = `work_item_current_${randomUUID()}`
    await prisma.labelMetricSnapshot.createMany({
      data: offsets.map((offset, index) => ({
        triggerWorkItemId:
          index === 0 ? currentTriggerWorkItemId : `work_item_past_${randomUUID()}`,
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
    await buildLabelSummary(prisma, {
      generationId,
      triggerWorkItemId: currentTriggerWorkItemId,
      sourceWatermarkAt: new Date(),
    })

    const rows = await prisma.labelSummaryCurrent.findMany({ where: { generationId } })
    expect(rows[0]?.dayDelta).toBeCloseTo(0.1)
    expect(rows[0]?.weekDelta).toBeCloseTo(0.3)
  })

  it('triggerWorkItemId で指定した snapshot だけを今回の値として使う', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    const watermarkAt = new Date(Date.now() - 60 * 60 * 1000)
    await prisma.labelMetricSnapshot.create({
      data: {
        triggerWorkItemId: 'work_item_designated',
        sourceCrawlRunId: `crawl-${randomUUID()}`,
        labelDefinitionId: labelDefinition.id,
        observedAt: new Date(watermarkAt.getTime() - 60 * 60 * 1000),
        sourceWatermarkAt: new Date(watermarkAt.getTime() - 60 * 60 * 1000),
        evaluatedCount: 100,
        trueCount: 20,
        prevalence: 0.2,
        completeness: 'complete',
        policyHash: 'hash',
        analyzerVersion: '1',
      },
    })
    // 別の triggerWorkItemId による、より新しい snapshot。呼び出し元が指定しない限り
    // 対象に含まれてはならない。
    await prisma.labelMetricSnapshot.create({
      data: {
        triggerWorkItemId: 'work_item_other',
        sourceCrawlRunId: `crawl-${randomUUID()}`,
        labelDefinitionId: labelDefinition.id,
        observedAt: new Date(watermarkAt.getTime() + 60 * 1000),
        sourceWatermarkAt: new Date(watermarkAt.getTime() + 60 * 1000),
        evaluatedCount: 100,
        trueCount: 90,
        prevalence: 0.9,
        completeness: 'complete',
        policyHash: 'hash',
        analyzerVersion: '1',
      },
    })

    const generationId = `generation-${randomUUID()}`
    await buildLabelSummary(prisma, {
      generationId,
      triggerWorkItemId: 'work_item_designated',
      sourceWatermarkAt: watermarkAt,
    })

    const rows = await prisma.labelSummaryCurrent.findMany({ where: { generationId } })
    expect(rows[0]?.prevalence).toBeCloseTo(0.2)
    expect(rows[0]?.evaluatedCount).toBe(100)
    expect(rows[0]?.trueCount).toBe(20)
  })

  it('triggerWorkItemId に該当する snapshot が存在しなければ行を作らない', async () => {
    await prisma.labelDefinition.create({
      data: { key: `unused_label_${randomUUID()}`, description: 'snapshot なしラベル' },
    })

    const generationId = `generation-${randomUUID()}`
    const result = await buildLabelSummary(prisma, {
      generationId,
      triggerWorkItemId: `work_item_nonexistent_${randomUUID()}`,
      sourceWatermarkAt: new Date(),
    })

    expect(result.rowCount).toBe(0)
  })
})
