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
    const earlier = new Date(now.getTime() - 2 * 60 * 60 * 1000)
    const later = new Date(now.getTime() - 60 * 60 * 1000)
    await prisma.labelMetricSnapshot.createMany({
      data: [
        {
          sourceCrawlRunId: `crawl-${randomUUID()}`,
          labelDefinitionId: labelDefinition.id,
          observedAt: earlier,
          sourceWatermarkAt: earlier,
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
          observedAt: later,
          sourceWatermarkAt: later,
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

  it('一部しか巡回できなかった partial snapshot は日次値に採用しない', async () => {
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
        evaluatedCount: 10,
        trueCount: 1,
        prevalence: 0.1,
        completeness: 'partial',
        policyHash: 'hash',
        analyzerVersion: '1',
      },
    })

    const result = await rollUpLabelMetricDaily(prisma, { now })

    expect(result.rowCount).toBe(0)
    expect(await prisma.labelMetricDaily.count()).toBe(0)
  })

  it('now より後に observedAt を持つ snapshot は取り込まない', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    const now = new Date()
    const future = new Date(now.getTime() + 60 * 60 * 1000)
    await prisma.labelMetricSnapshot.create({
      data: {
        sourceCrawlRunId: `crawl-${randomUUID()}`,
        labelDefinitionId: labelDefinition.id,
        observedAt: future,
        sourceWatermarkAt: future,
        evaluatedCount: 200,
        trueCount: 100,
        prevalence: 0.5,
        completeness: 'complete',
        policyHash: 'hash',
        analyzerVersion: '1',
      },
    })

    // backlog 処理で now (古い watermark) を渡した場合、既に生成済みのより新しい
    // watermark の snapshot を取り込んで日次値を書き換えてはならない。
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
