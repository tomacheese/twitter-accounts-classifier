import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { rollUpLabelMetricDaily } from './build-label-metric-daily'

describe.skipIf(!process.env.DATABASE_URL)('rollUpLabelMetricDaily', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.labelMetricDaily.deleteMany()
    await prisma.labelMetricSnapshot.deleteMany()
    await prisma.labelDefinition.deleteMany()
  })

  it('同じ日の snapshot は最後の 1 件を日次値として採用する', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    const now = new Date()
    const morning = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 1, 0, 0),
    )
    const evening = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 20, 0, 0),
    )
    await prisma.labelMetricSnapshot.createMany({
      data: [
        {
          sourceCrawlRunId: `crawl-${randomUUID()}`,
          labelDefinitionId: labelDefinition.id,
          observedAt: morning,
          sourceWatermarkAt: morning,
          evaluatedCount: 100,
          trueCount: 10,
          prevalence: 0.1,
          completeness: 'complete',
          policyHash: 'hash',
          analyzerVersion: '1',
        },
        {
          sourceCrawlRunId: `crawl-${randomUUID()}`,
          labelDefinitionId: labelDefinition.id,
          observedAt: evening,
          sourceWatermarkAt: evening,
          evaluatedCount: 120,
          trueCount: 36,
          prevalence: 0.3,
          completeness: 'complete',
          policyHash: 'hash',
          analyzerVersion: '1',
        },
      ],
    })

    await rollUpLabelMetricDaily(prisma, { now })

    const rows = await prisma.labelMetricDaily.findMany({
      where: { labelDefinitionId: labelDefinition.id },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.prevalence).toBeCloseTo(0.3)
    expect(rows[0]?.evaluatedCount).toBe(120)
  })

  it('集計に失敗した snapshot は日次値に採用しない', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    const now = new Date()
    await prisma.labelMetricSnapshot.create({
      data: {
        sourceCrawlRunId: `crawl-${randomUUID()}`,
        labelDefinitionId: labelDefinition.id,
        observedAt: now,
        sourceWatermarkAt: now,
        evaluatedCount: 0,
        trueCount: 0,
        prevalence: 0,
        completeness: 'unknown',
        policyHash: 'hash',
        analyzerVersion: '1',
      },
    })

    const result = await rollUpLabelMetricDaily(prisma, { now })

    expect(result.rowCount).toBe(0)
    expect(await prisma.labelMetricDaily.count()).toBe(0)
  })

  it('再実行しても同じ日の行は重複せず更新される', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    const now = new Date()
    await prisma.labelMetricSnapshot.create({
      data: {
        sourceCrawlRunId: `crawl-${randomUUID()}`,
        labelDefinitionId: labelDefinition.id,
        observedAt: now,
        sourceWatermarkAt: now,
        evaluatedCount: 50,
        trueCount: 5,
        prevalence: 0.1,
        completeness: 'complete',
        policyHash: 'hash',
        analyzerVersion: '1',
      },
    })

    await rollUpLabelMetricDaily(prisma, { now })
    await rollUpLabelMetricDaily(prisma, { now })

    expect(await prisma.labelMetricDaily.count()).toBe(1)
  })
})
