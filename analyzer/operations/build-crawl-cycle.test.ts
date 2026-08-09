import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../generated/prisma'
import { getPrismaClient } from '../db/client'
import { buildOrUpdateCrawlCycle } from './build-crawl-cycle'

/**
 * @returns buildOrUpdateCrawlCycle が参照するメソッドのみ差し替え可能な Prisma クライアントのモックと、
 * その差し替え用の関数
 */
function createMockPrismaClient(): {
  prisma: PrismaClient
  findUniqueOrThrow: ReturnType<typeof vi.fn>
  findUnique: ReturnType<typeof vi.fn>
  cycleUpsert: ReturnType<typeof vi.fn>
  stageUpsert: ReturnType<typeof vi.fn>
} {
  const findUniqueOrThrow = vi.fn()
  const findUnique = vi.fn()
  const cycleUpsert = vi.fn().mockResolvedValue({ id: 'cycle-1' })
  const stageUpsert = vi.fn()
  return {
    prisma: {
      crawlRun: { findUniqueOrThrow },
      analysisWorkItem: { findUnique },
      operationCycle: { upsert: cycleUpsert },
      operationStage: { upsert: stageUpsert },
    } as unknown as PrismaClient,
    findUniqueOrThrow,
    findUnique,
    cycleUpsert,
    stageUpsert,
  }
}

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
    expect(stages).toHaveLength(3)
  })

  it('3 Stage すべて succeeded なら Cycle status は succeeded になる', async () => {
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

  it('CrawlRun が partial でも read_model_refresh は実行し、Cycle status は partial のままにする', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'partial',
      },
    })

    for (const kind of ['label_aggregate_refresh', 'read_model_refresh']) {
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
    expect(readModelRefreshStage.status).toBe('succeeded')
    expect(readModelRefreshStage.errorSummary).toBeNull()
    expect(cycle.status).toBe('partial')
    expect(cycle.attentionRequired).toBe(true)

    const crawlStage = await prisma.operationStage.findUniqueOrThrow({
      where: { cycleId_stageKey: { cycleId: cycle.id, stageKey: 'crawl' } },
    })
    expect(crawlStage.status).toBe('partial')

    // label_aggregate_refresh は partial なデータに対しても実際に処理を
    // 完了しているため、succeeded のまま表示してよい。
    const labelAggregateStage = await prisma.operationStage.findUniqueOrThrow({
      where: { cycleId_stageKey: { cycleId: cycle.id, stageKey: 'label_aggregate_refresh' } },
    })
    expect(labelAggregateStage.status).toBe('succeeded')
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
        kind: 'label_aggregate_refresh',
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
      where: { cycleId_stageKey: { cycleId: cycle.id, stageKey: 'label_aggregate_refresh' } },
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
    for (const kind of ['label_aggregate_refresh', 'read_model_refresh']) {
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
    expect(stages).toHaveLength(3)
  })
})

describe('buildOrUpdateCrawlCycle (mock)', () => {
  it('crawl が failed の場合、未 enqueue の label_aggregate_refresh/read_model_refresh は blocked_by_upstream になる', async () => {
    const { prisma, findUniqueOrThrow, findUnique, cycleUpsert, stageUpsert } =
      createMockPrismaClient()
    findUniqueOrThrow.mockResolvedValue({
      id: 'run-1',
      status: 'failed',
      startedAt: new Date(),
      finishedAt: new Date(),
    } as never)
    findUnique.mockResolvedValue(null)

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: 'run-1' })

    const upsertCall = cycleUpsert.mock.calls[0]?.[0] as { create: { status: string } }
    expect(upsertCall.create.status).toBe('failed')
    // Stage 単位の検証は upsertCycleWithStages 経由の operationStage.upsert 呼び出しで確認する
    const stageUpserts = stageUpsert.mock.calls as {
      where: { cycleId_stageKey: { stageKey: string } }
      create: { status: string }
    }[][]
    const labelAggregateStage = stageUpserts.find(
      (call) => call[0]?.where.cycleId_stageKey.stageKey === 'label_aggregate_refresh',
    )
    expect(labelAggregateStage?.[0]?.create.status).toBe('blocked_by_upstream')
  })
})
