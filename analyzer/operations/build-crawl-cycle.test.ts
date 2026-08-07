import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildOrUpdateCrawlCycle, deriveCycleStatus } from './build-crawl-cycle'

describe('deriveCycleStatus', () => {
  it('4 Stage すべて succeeded なら succeeded を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'succeeded', 'succeeded', 'succeeded'])).toBe(
      'succeeded',
    )
  })

  it('crawl が succeeded で後続に failed があれば partial を返す', () => {
    expect(deriveCycleStatus(['succeeded', 'failed', 'succeeded', 'succeeded'])).toBe('partial')
  })

  it('crawl 自体が failed なら failed を返す', () => {
    expect(deriveCycleStatus(['failed', 'waiting', 'waiting', 'waiting'])).toBe('failed')
  })
})

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
