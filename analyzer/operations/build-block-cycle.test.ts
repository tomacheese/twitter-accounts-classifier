import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildOrUpdateBlockCycle } from './build-block-cycle'

describe.skipIf(!process.env.DATABASE_URL)('buildOrUpdateBlockCycle', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.operationStage.deleteMany()
    await prisma.operationCycle.deleteMany()
    await prisma.analysisRun.deleteMany()
    await prisma.analysisWorkItem.deleteMany()
    await prisma.blockAccountRun.deleteMany()
    await prisma.blockRun.deleteMany()
  })

  /**
   * @param status - 作成する BlockRun の status
   * @returns 作成した BlockRun の ID
   */
  async function createRun(status: string): Promise<string> {
    const run = await prisma.blockRun.create({
      data: {
        id: `block-${randomUUID()}`,
        startedAt: new Date(),
        lastHeartbeatAt: new Date(),
        finishedAt: new Date(),
        status,
      },
    })
    return run.id
  }

  it('Viewer が絞り込む kind と同じ block を書き込む', async () => {
    const runId = await createRun('success')

    await buildOrUpdateBlockCycle(prisma, { blockRunId: runId })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'block_run', sourceId: runId } },
    })
    expect(cycle.kind).toBe('block')
  })

  it('reconciliation の WorkItem が succeeded なら Cycle status は succeeded になる', async () => {
    const runId = await createRun('success')
    await prisma.analysisWorkItem.create({
      data: {
        kind: 'block_reconciliation',
        triggerType: 'block_run',
        triggerId: runId,
        status: 'succeeded',
      },
    })

    await buildOrUpdateBlockCycle(prisma, { blockRunId: runId })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'block_run', sourceId: runId } },
    })
    expect(cycle.status).toBe('succeeded')

    const stages = await prisma.operationStage.findMany({ where: { cycleId: cycle.id } })
    expect(stages).toHaveLength(2)
  })

  it('BlockRun 自体が failed なら Cycle status は failed になる', async () => {
    const runId = await createRun('failed')
    await prisma.analysisWorkItem.create({
      data: {
        kind: 'block_reconciliation',
        triggerType: 'block_run',
        triggerId: runId,
        status: 'succeeded',
      },
    })

    await buildOrUpdateBlockCycle(prisma, { blockRunId: runId })

    const cycle = await prisma.operationCycle.findUniqueOrThrow({
      where: { sourceType_sourceId: { sourceType: 'block_run', sourceId: runId } },
    })
    expect(cycle.status).toBe('failed')
    expect(cycle.attentionRequired).toBe(true)
  })
})
