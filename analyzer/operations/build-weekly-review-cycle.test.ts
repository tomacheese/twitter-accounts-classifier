import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildOrUpdateWeeklyReviewCycle } from './build-weekly-review-cycle'

describe.skipIf(!process.env.DATABASE_URL)('buildOrUpdateWeeklyReviewCycle', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.operationStage.deleteMany()
    await prisma.operationCycle.deleteMany()
    await prisma.analysisRun.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.weeklyAnalysisRun.deleteMany()
  })

  /**
   * @param status - 作成する WeeklyAnalysisRun の status
   * @returns 作成した WeeklyAnalysisRun の ID
   */
  async function createRun(status: string): Promise<string> {
    const run = await prisma.weeklyAnalysisRun.create({
      data: {
        id: `weekly-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status,
        sampledAccountIds: [],
      },
    })
    return run.id
  }

  it('Viewer が絞り込む kind と同じ weekly_review を書き込む', async () => {
    const runId = await createRun('success')

    await buildOrUpdateWeeklyReviewCycle(prisma, { weeklyAnalysisRunId: runId })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'weekly_analysis_run', sourceId: runId } },
    })
    expect(cycle.kind).toBe('weekly_review')
  })

  it('ingest の WorkItem が succeeded なら Cycle status は succeeded になる', async () => {
    const runId = await createRun('success')
    await prisma.analysisWorkItem.create({
      data: {
        kind: 'weekly_review_ingest',
        triggerType: 'weekly_analysis_run',
        triggerId: runId,
        status: 'succeeded',
      },
    })

    await buildOrUpdateWeeklyReviewCycle(prisma, { weeklyAnalysisRunId: runId })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'weekly_analysis_run', sourceId: runId } },
    })
    expect(cycle.status).toBe('succeeded')

    const stages = await prisma.operationStage.findMany({ where: { cycleId: cycle.id } })
    expect(stages).toHaveLength(2)
  })

  it('ingest の WorkItem が存在しなければ partial になる', async () => {
    const runId = await createRun('success')

    await buildOrUpdateWeeklyReviewCycle(prisma, { weeklyAnalysisRunId: runId })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'weekly_analysis_run', sourceId: runId } },
    })
    expect(cycle.status).toBe('partial')
    expect(cycle.attentionRequired).toBe(true)
  })
})
