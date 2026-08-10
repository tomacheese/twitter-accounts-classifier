import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { reconcileActiveOperationCycles } from './reconcile-active-cycles'

describe.skipIf(!process.env.DATABASE_URL)('reconcileActiveOperationCycles', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.operationStage.deleteMany()
    await prisma.operationCycle.deleteMany()
    await prisma.analysisRun.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.crawlRun.deleteMany()
    await prisma.blockRun.deleteMany()
    await prisma.weeklyAnalysisRun.deleteMany()
  })

  it('running な CrawlRun/BlockRun/WeeklyAnalysisRun それぞれについて Cycle を作成する', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        status: 'running',
      },
    })
    const blockRun = await prisma.blockRun.create({
      data: {
        id: `block-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        status: 'running',
      },
    })
    const weeklyAnalysisRun = await prisma.weeklyAnalysisRun.create({
      data: {
        id: `weekly-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        status: 'running',
        sampledAccountIds: [],
      },
    })

    await reconcileActiveOperationCycles(prisma)

    const crawlCycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    expect(crawlCycle.status).toBe('running')

    const blockCycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'block_run', sourceId: blockRun.id } },
    })
    expect(blockCycle.status).toBe('running')

    const weeklyCycle = await prisma.operationCycle.findUniqueOrThrow({
      where: {
        sourceType_sourceId: {
          sourceType: 'weekly_analysis_run',
          sourceId: weeklyAnalysisRun.id,
        },
      },
    })
    expect(weeklyCycle.status).toBe('running')
  })

  it('同じ Run を複数回 reconcile しても Cycle/Stage が重複しない', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        status: 'running',
      },
    })

    await reconcileActiveOperationCycles(prisma)
    await reconcileActiveOperationCycles(prisma)

    const cycles = await prisma.operationCycle.findMany({
      where: { sourceType: 'crawl_run', sourceId: crawlRun.id },
    })
    expect(cycles).toHaveLength(1)
  })

  it('root Run が terminal に遷移した後、downstream WorkItem が settle する前でも Cycle が更新される', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        status: 'running',
      },
    })
    await reconcileActiveOperationCycles(prisma)
    const runningCycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    expect(runningCycle.status).toBe('running')

    // root Run が完了し、downstream WorkItem は queued のまま (settle 前)
    await prisma.crawlRun.update({
      where: { id: crawlRun.id },
      data: { status: 'success', finishedAt: new Date() },
    })
    await prisma.analysisWorkItem.create({
      data: { kind: 'label_aggregate_refresh', triggerType: 'crawl_run', triggerId: crawlRun.id },
    })

    await reconcileActiveOperationCycles(prisma)

    const updatedCycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    expect(updatedCycle.status).toBe('running')

    const crawlStage = await prisma.operationStage.findUniqueOrThrow({
      where: { cycleId_stageKey: { cycleId: updatedCycle.id, stageKey: 'crawl' } },
    })
    expect(crawlStage.status).toBe('succeeded')

    const labelStage = await prisma.operationStage.findUniqueOrThrow({
      where: { cycleId_stageKey: { cycleId: updatedCycle.id, stageKey: 'label_aggregate_refresh' } },
    })
    expect(labelStage.status).toBe('waiting')
  })

  it('既に terminal な OperationCycle は reconcile 対象に含めない', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })
    for (const kind of ['label_aggregate_refresh', 'read_model_refresh']) {
      await prisma.analysisWorkItem.create({
        data: { kind, triggerType: 'crawl_run', triggerId: crawlRun.id, status: 'succeeded' },
      })
    }

    const { buildOrUpdateCrawlCycle } = await import('./build-crawl-cycle')
    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })
    const before = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    expect(before.status).toBe('succeeded')

    await reconcileActiveOperationCycles(prisma)

    const after = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    // reconcile 対象に含まれていれば upsert が走り updatedAt が更新されるため、
    // 不変であることをもって「再計算されなかった」ことを確認する。
    expect(after.updatedAt).toEqual(before.updatedAt)
  })
})
