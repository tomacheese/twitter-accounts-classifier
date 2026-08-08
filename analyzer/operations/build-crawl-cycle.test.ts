import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildOrUpdateCrawlCycle } from './build-crawl-cycle'

describe.skipIf(!process.env.DATABASE_URL)('buildOrUpdateCrawlCycle', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.operationStage.deleteMany()
    await prisma.operationCycle.deleteMany()
    await prisma.analysisRun.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.crawlRun.deleteMany()
  })

  it('CrawlRun が success で後続 WorkItem が存在しない場合、Cycle status は partial になる', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    expect(cycle.status).toBe('partial')
    expect(cycle.attentionRequired).toBe(true)

    const stages = await prisma.operationStage.findMany({ where: { cycleId: cycle.id } })
    expect(stages).toHaveLength(4)
  })

  it('4 Stage すべて succeeded なら Cycle status は succeeded になる', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })

    for (const kind of ['label_metrics', 'finding_generation', 'read_model_refresh']) {
      const workItem = await prisma.analysisWorkItem.create({
        data: { kind, triggerType: 'crawl_run', triggerId: crawlRun.id, status: 'succeeded' },
      })
      await prisma.analysisRun.create({
        data: {
          workItemId: workItem.id,
          attemptNumber: 1,
          finishedAt: new Date(),
          status: 'succeeded',
        },
      })
    }

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    expect(cycle.status).toBe('succeeded')
    expect(cycle.attentionRequired).toBe(false)
  })

  it('CrawlRun が partial なら read_model_refresh は skipped になり、Cycle status は succeeded にならない', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'partial',
      },
    })

    for (const kind of ['label_metrics', 'finding_generation', 'read_model_refresh']) {
      const workItem = await prisma.analysisWorkItem.create({
        data: { kind, triggerType: 'crawl_run', triggerId: crawlRun.id, status: 'succeeded' },
      })
      await prisma.analysisRun.create({
        data: {
          workItemId: workItem.id,
          attemptNumber: 1,
          finishedAt: new Date(),
          status: 'succeeded',
        },
      })
    }

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    const readModelRefreshStage = await prisma.operationStage.findUniqueOrThrow({
      where: { cycleId_stageKey: { cycleId: cycle.id, stageKey: 'read_model_refresh' } },
    })
    expect(readModelRefreshStage.status).toBe('skipped')
    expect(readModelRefreshStage.errorSummary).toContain('partial')
    expect(cycle.status).toBe('partial')
    expect(cycle.attentionRequired).toBe(true)

    // label_metrics/finding_generation は partial なデータに対しても実際に処理を
    // 完了しているため、succeeded のまま表示してよい。
    const labelMetricsStage = await prisma.operationStage.findUniqueOrThrow({
      where: { cycleId_stageKey: { cycleId: cycle.id, stageKey: 'label_metrics' } },
    })
    expect(labelMetricsStage.status).toBe('succeeded')
  })

  it('Viewer が絞り込む kind と同じ crawl を書き込む', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    expect(cycle.kind).toBe('crawl')
  })

  it('WorkItem が dead なら Stage は failed になり、エラー概要を引き継ぐ', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })
    await prisma.analysisWorkItem.create({
      data: {
        kind: 'label_metrics',
        triggerType: 'crawl_run',
        triggerId: crawlRun.id,
        status: 'dead',
        attemptCount: 5,
        lastErrorSummary: 'boom',
      },
    })

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    const stage = await prisma.operationStage.findUniqueOrThrow({
      where: { cycleId_stageKey: { cycleId: cycle.id, stageKey: 'label_metrics' } },
    })
    expect(stage.status).toBe('failed')
    expect(stage.errorSummary).toBe('boom')
    expect(stage.attemptCount).toBe(5)
    expect(cycle.status).toBe('partial')
  })

  it('WorkItem が leased なら Stage は running になる', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        status: 'running',
      },
    })
    for (const kind of ['label_metrics', 'finding_generation', 'read_model_refresh']) {
      await prisma.analysisWorkItem.create({
        data: { kind, triggerType: 'crawl_run', triggerId: crawlRun.id, status: 'leased' },
      })
    }

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    expect(cycle.status).toBe('running')
  })

  it('再度呼び出しても Cycle・Stage が重複作成されない', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })
    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const cycles = await prisma.operationCycle.findMany({ where: { sourceId: crawlRun.id } })
    expect(cycles).toHaveLength(1)
    const stages = await prisma.operationStage.findMany({ where: { cycleId: cycles[0]?.id } })
    expect(stages).toHaveLength(4)
  })
})
