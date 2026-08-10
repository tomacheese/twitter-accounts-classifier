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

    const now = new Date('2026-08-10T12:00:00.000Z')
    const earlier = new Date(now.getTime() - 2 * 60 * 60 * 1000)
    const later = new Date(now.getTime() - 60 * 60 * 1000)
    await prisma.labelMetricSnapshot.createMany({
      data: [
        {
          triggerWorkItemId: `work_item_${randomUUID()}`,
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
          triggerWorkItemId: `work_item_${randomUUID()}`,
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
        triggerWorkItemId: `work_item_${randomUUID()}`,
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
        triggerWorkItemId: `work_item_${randomUUID()}`,
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
        triggerWorkItemId: `work_item_${randomUUID()}`,
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

  it('古い observedAt の backlog build は、既に採用済みの新しい observedAt の値を巻き戻さない', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    // 固定の正午時刻を使う。実行時刻を基準にすると 1 時間差の older/newer が
    // UTC 日付をまたぎ、日次バケットが分かれてテストが不安定になるため。
    const older = new Date('2026-01-15T12:00:00Z')
    const newer = new Date(older.getTime() + 60 * 60 * 1000)
    await prisma.labelMetricSnapshot.createMany({
      data: [
        {
          triggerWorkItemId: `work_item_${randomUUID()}`,
          sourceCrawlRunId: `crawl-${randomUUID()}`,
          labelDefinitionId: labelDefinition.id,
          observedAt: older,
          sourceWatermarkAt: older,
          evaluatedCount: 100,
          trueCount: 10,
          prevalence: 0.1,
          completeness: 'complete',
          policyHash: 'hash',
          analyzerVersion: '1',
        },
        {
          triggerWorkItemId: `work_item_${randomUUID()}`,
          sourceCrawlRunId: `crawl-${randomUUID()}`,
          labelDefinitionId: labelDefinition.id,
          observedAt: newer,
          sourceWatermarkAt: newer,
          evaluatedCount: 120,
          trueCount: 60,
          prevalence: 0.5,
          completeness: 'complete',
          policyHash: 'hash',
          analyzerVersion: '1',
        },
      ],
    })

    // 先行 worker が新しい observedAt まで含めて build し、日次値を確定させる。
    await rollUpLabelMetricDaily(prisma, { now: newer })

    // その後、古い observedAt までしか見えていない backlog 分の build が
    // 遅れて実行される。この再計算で確定済みの新しい値を巻き戻してはならない。
    await rollUpLabelMetricDaily(prisma, { now: older })

    const rows = await prisma.labelMetricDaily.findMany({
      where: { labelDefinitionId: labelDefinition.id },
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.evaluatedCount).toBe(120)
    expect(rows[0]?.prevalence).toBeCloseTo(0.5)
  })

  it('再実行しても同じ日の行は重複せず更新される', async () => {
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: `test_label_${randomUUID()}`, description: 'テスト用ラベル' },
    })

    const now = new Date()
    await prisma.labelMetricSnapshot.create({
      data: {
        triggerWorkItemId: `work_item_${randomUUID()}`,
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
