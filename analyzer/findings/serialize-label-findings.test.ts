import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getPrismaClient } from '../db/client'
import { runLabelFindingsSerialized } from './serialize-label-findings'

const MODEL_KEY = 'label_findings'

describe.skipIf(!process.env.DATABASE_URL)('runLabelFindingsSerialized', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.readModelState.deleteMany({ where: { modelKey: MODEL_KEY } })
  })

  it('skips run when snapshotAt is not newer than the recorded watermark', async () => {
    await prisma.readModelState.create({
      data: {
        modelKey: MODEL_KEY,
        schemaVersion: 1,
        status: 'healthy',
        sourceWatermarkAt: new Date('2026-08-05T00:00:00Z'),
      },
    })

    const run = vi.fn().mockResolvedValue(undefined)
    await runLabelFindingsSerialized(prisma, {
      snapshotAt: new Date('2026-08-04T00:00:00Z'),
      run,
    })

    expect(run).not.toHaveBeenCalled()
    const state = await prisma.readModelState.findUniqueOrThrow({ where: { modelKey: MODEL_KEY } })
    expect(state.sourceWatermarkAt?.toISOString()).toBe(
      new Date('2026-08-05T00:00:00Z').toISOString(),
    )
  })

  it('runs and advances the watermark when snapshotAt is newer', async () => {
    await prisma.readModelState.create({
      data: {
        modelKey: MODEL_KEY,
        schemaVersion: 1,
        status: 'healthy',
        sourceWatermarkAt: new Date('2026-08-04T00:00:00Z'),
      },
    })

    const run = vi.fn().mockResolvedValue(undefined)
    await runLabelFindingsSerialized(prisma, {
      snapshotAt: new Date('2026-08-05T00:00:00Z'),
      run,
    })

    expect(run).toHaveBeenCalledTimes(1)
    const state = await prisma.readModelState.findUniqueOrThrow({ where: { modelKey: MODEL_KEY } })
    expect(state.sourceWatermarkAt?.toISOString()).toBe(
      new Date('2026-08-05T00:00:00Z').toISOString(),
    )
    expect(state.status).toBe('healthy')
  })
})
