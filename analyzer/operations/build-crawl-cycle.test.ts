import { describe, it, expect, beforeEach, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../generated/prisma'
import { getPrismaClient } from '../db/client'
import { buildOrUpdateCrawlCycle } from './build-crawl-cycle'
import { NEVER_ENQUEUED_ERROR_SUMMARY } from './cycle-common'

/**
 * @returns buildOrUpdateCrawlCycle が参照するメソッドのみ差し替え可能な Prisma クライアントのモックと、
 * その差し替え用の関数
 */
function createMockPrismaClient(): {
  prisma: PrismaClient
  findUniqueOrThrow: ReturnType<typeof vi.fn>
  findUnique: ReturnType<typeof vi.fn>
  stageFindMany: ReturnType<typeof vi.fn>
  cycleUpsert: ReturnType<typeof vi.fn>
  stageUpsert: ReturnType<typeof vi.fn>
  stageDeleteMany: ReturnType<typeof vi.fn>
} {
  const findUniqueOrThrow = vi.fn()
  const findUnique = vi.fn()
  const stageFindMany = vi.fn().mockResolvedValue([])
  const cycleUpsert = vi.fn().mockResolvedValue({ id: 'cycle-1' })
  const stageUpsert = vi.fn()
  const stageDeleteMany = vi.fn().mockResolvedValue({ count: 0 })
  const prisma = {
    crawlRun: { findUniqueOrThrow },
    analysisWorkItem: { findUnique },
    operationCycle: { upsert: cycleUpsert },
    operationStage: { upsert: stageUpsert, findMany: stageFindMany, deleteMany: stageDeleteMany },
    $transaction: vi.fn((fn: (tx: unknown) => Promise<void>) => fn(prisma)),
  } as unknown as PrismaClient
  return {
    prisma,
    findUniqueOrThrow,
    findUnique,
    stageFindMany,
    cycleUpsert,
    stageUpsert,
    stageDeleteMany,
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
    expect(stages).toHaveLength(2)
  })

  it('2 Stage すべて succeeded なら Cycle status は succeeded になる', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })

    for (const kind of ['label_aggregate_refresh']) {
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

  it('CrawlRun が partial なら Cycle status は partial のままになる', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'partial',
      },
    })
    const workItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'label_aggregate_refresh',
        triggerType: 'crawl_run',
        triggerId: crawlRun.id,
        status: 'succeeded',
      },
    })
    await prisma.analysisRun.create({
      data: {
        workItemId: workItem.id,
        attemptNumber: 1,
        finishedAt: new Date(),
        status: 'succeeded',
      },
    })

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
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
    for (const kind of ['label_aggregate_refresh']) {
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

  it('旧 v1 cycle (read_model_refresh の実履歴があり label_aggregate_refresh が未 enqueue) は書き込みを行わない', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })
    const legacyCycle = await prisma.operationCycle.create({
      data: {
        kind: 'crawl',
        sourceType: 'crawl_run',
        sourceId: crawlRun.id,
        triggeredAt: crawlRun.startedAt,
        status: 'succeeded',
        modelVersion: '1',
      },
    })
    await prisma.operationStage.create({
      data: {
        cycleId: legacyCycle.id,
        stageKey: 'read_model_refresh',
        sequence: 2,
        requiredness: 'required',
        status: 'succeeded',
        finishedAt: new Date(),
      },
    })

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const cycleAfter = await prisma.operationCycle.findUniqueOrThrow({
      where: { id: legacyCycle.id },
    })
    expect(cycleAfter.modelVersion).toBe('1')
    const stagesAfter = await prisma.operationStage.findMany({
      where: { cycleId: legacyCycle.id },
    })
    expect(stagesAfter).toHaveLength(1)
    expect(stagesAfter[0]?.stageKey).toBe('read_model_refresh')
  })

  it('read_model_refresh の実履歴があっても label_aggregate_refresh が enqueue 済みなら通常どおり処理する', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })
    const legacyCycle = await prisma.operationCycle.create({
      data: {
        kind: 'crawl',
        sourceType: 'crawl_run',
        sourceId: crawlRun.id,
        triggeredAt: crawlRun.startedAt,
        status: 'succeeded',
        modelVersion: '1',
      },
    })
    await prisma.operationStage.create({
      data: {
        cycleId: legacyCycle.id,
        stageKey: 'read_model_refresh',
        sequence: 2,
        requiredness: 'required',
        status: 'succeeded',
        finishedAt: new Date(),
      },
    })
    const workItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'label_aggregate_refresh',
        triggerType: 'crawl_run',
        triggerId: crawlRun.id,
        status: 'succeeded',
      },
    })
    await prisma.analysisRun.create({
      data: {
        workItemId: workItem.id,
        attemptNumber: 1,
        finishedAt: new Date(),
        status: 'succeeded',
      },
    })

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const cycleAfter = await prisma.operationCycle.findUniqueOrThrow({
      where: { id: legacyCycle.id },
    })
    expect(cycleAfter.modelVersion).toBe('2')
    expect(cycleAfter.status).toBe('succeeded')
    // read_model_refresh は phantom ではないため、deleteObsoleteOperationStages() で削除されない。
    const stagesAfter = await prisma.operationStage.findMany({
      where: { cycleId: legacyCycle.id },
    })
    expect(stagesAfter.map((stage) => stage.stageKey).toSorted()).toEqual([
      'crawl',
      'label_aggregate_refresh',
      'read_model_refresh',
    ])
  })

  it('phantom な read_model_refresh stage は再構築時に削除される', async () => {
    const crawlRun = await prisma.crawlRun.create({
      data: {
        id: `crawl-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status: 'success',
      },
    })
    const cycle = await prisma.operationCycle.create({
      data: {
        kind: 'crawl',
        sourceType: 'crawl_run',
        sourceId: crawlRun.id,
        triggeredAt: crawlRun.startedAt,
        status: 'partial',
        modelVersion: '2',
      },
    })
    await prisma.operationStage.create({
      data: {
        cycleId: cycle.id,
        stageKey: 'read_model_refresh',
        sequence: 3,
        requiredness: 'required',
        status: 'failed',
        attemptCount: 0,
        errorSummary: NEVER_ENQUEUED_ERROR_SUMMARY,
      },
    })
    const workItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'label_aggregate_refresh',
        triggerType: 'crawl_run',
        triggerId: crawlRun.id,
        status: 'succeeded',
      },
    })
    await prisma.analysisRun.create({
      data: {
        workItemId: workItem.id,
        attemptNumber: 1,
        finishedAt: new Date(),
        status: 'succeeded',
      },
    })

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const stagesAfter = await prisma.operationStage.findMany({ where: { cycleId: cycle.id } })
    expect(stagesAfter.map((stage) => stage.stageKey).toSorted()).toEqual([
      'crawl',
      'label_aggregate_refresh',
    ])
  })

  it('finishCrawlRun が enqueue する label_aggregate_refresh と同じ kind/triggerType/triggerId で WorkItem を検索する', async () => {
    // producer 側 (crawler/db/crawl-run-repository.test.ts) の kind/triggerType/triggerId と
    // 一致しないと、ここでの契約の崩れが検出されない。
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
        status: 'succeeded',
      },
    })

    await buildOrUpdateCrawlCycle(prisma, { crawlRunId: crawlRun.id })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'crawl_run', sourceId: crawlRun.id } },
    })
    const stage = await prisma.operationStage.findUniqueOrThrow({
      where: { cycleId_stageKey: { cycleId: cycle.id, stageKey: 'label_aggregate_refresh' } },
    })
    expect(stage.status).toBe('succeeded')
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
    expect(stages).toHaveLength(2)
  })
})

describe('buildOrUpdateCrawlCycle (mock)', () => {
  it('crawl が failed の場合、未 enqueue の label_aggregate_refresh は blocked_by_upstream になる', async () => {
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
