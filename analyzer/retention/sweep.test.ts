import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { runRetentionSweep } from './sweep'

function createMockPrisma(
  overrides: { eligibleWorkItemIds?: string[]; currentGenerationId?: string | null } = {},
) {
  const analysisRunDeleteMany = vi.fn().mockResolvedValue({ count: 3 })
  const analysisWorkItemFindMany = vi
    .fn()
    .mockResolvedValue(
      (overrides.eligibleWorkItemIds ?? ['work-item-1', 'work-item-2']).map((id) => ({ id })),
    )
  const analysisWorkItemDeleteMany = vi.fn().mockResolvedValue({ count: 2 })
  const labelMetricSnapshotDeleteMany = vi.fn().mockResolvedValue({ count: 1 })
  const readModelPointerFindUnique = vi
    .fn()
    .mockResolvedValue(
      overrides.currentGenerationId === undefined
        ? { currentGenerationId: 'generation-current' }
        : overrides.currentGenerationId === null
          ? null
          : { currentGenerationId: overrides.currentGenerationId },
    )
  const overviewSnapshotDeleteMany = vi.fn().mockResolvedValue({ count: 4 })
  const prisma = {
    analysisRun: { deleteMany: analysisRunDeleteMany },
    analysisWorkItem: {
      findMany: analysisWorkItemFindMany,
      deleteMany: analysisWorkItemDeleteMany,
    },
    labelMetricSnapshot: { deleteMany: labelMetricSnapshotDeleteMany },
    readModelPointer: { findUnique: readModelPointerFindUnique },
    overviewSnapshot: { deleteMany: overviewSnapshotDeleteMany },
  } as unknown as PrismaClient
  return {
    prisma,
    analysisRunDeleteMany,
    analysisWorkItemFindMany,
    analysisWorkItemDeleteMany,
    labelMetricSnapshotDeleteMany,
    readModelPointerFindUnique,
    overviewSnapshotDeleteMany,
  }
}

describe('runRetentionSweep', () => {
  it('AnalysisRunを180日より前のfinishedAtで削除する', async () => {
    const { prisma, analysisRunDeleteMany } = createMockPrisma()
    const now = new Date('2026-08-08T00:00:00.000Z')

    await runRetentionSweep(prisma, now)

    const call = analysisRunDeleteMany.mock.calls[0][0] as { where: { finishedAt: { lt: Date } } }
    expect(call.where.finishedAt.lt.toISOString()).toBe('2026-02-09T00:00:00.000Z')
  })

  it('LabelMetricSnapshotを90日より前のobservedAtで削除する', async () => {
    const { prisma, labelMetricSnapshotDeleteMany } = createMockPrisma()
    const now = new Date('2026-08-08T00:00:00.000Z')

    await runRetentionSweep(prisma, now)

    const call = labelMetricSnapshotDeleteMany.mock.calls[0][0] as {
      where: { observedAt: { lt: Date } }
    }
    expect(call.where.observedAt.lt.toISOString()).toBe('2026-05-10T00:00:00.000Z')
  })

  it('完了済みWorkItemを30日より前のupdatedAtで対象にする (参照中のAnalysisRunの有無は問わない)', async () => {
    const { prisma, analysisWorkItemFindMany } = createMockPrisma()
    const now = new Date('2026-08-08T00:00:00.000Z')

    await runRetentionSweep(prisma, now)

    const call = analysisWorkItemFindMany.mock.calls[0][0] as {
      where: { status: string; updatedAt: { lt: Date } }
    }
    expect(call.where.status).toBe('succeeded')
    expect(call.where.updatedAt.lt.toISOString()).toBe('2026-07-09T00:00:00.000Z')
    expect(call.where).not.toHaveProperty('runs')
  })

  it('削除対象WorkItemに紐づくAnalysisRunを年齢を問わず先に削除してからWorkItemを削除する', async () => {
    const { prisma, analysisRunDeleteMany, analysisWorkItemFindMany, analysisWorkItemDeleteMany } =
      createMockPrisma({ eligibleWorkItemIds: ['work-item-1', 'work-item-2'] })
    analysisRunDeleteMany
      .mockResolvedValueOnce({ count: 0 }) // 180日基準の一般 sweep
      .mockResolvedValueOnce({ count: 5 }) // WorkItem 削除に連動した cascade
    analysisWorkItemDeleteMany.mockResolvedValue({ count: 2 })

    const result = await runRetentionSweep(prisma, new Date('2026-08-08T00:00:00.000Z'))

    expect(analysisRunDeleteMany).toHaveBeenCalledTimes(2)
    const cascadeCall = analysisRunDeleteMany.mock.calls[1][0] as {
      where: { workItemId: { in: string[] } }
    }
    expect(cascadeCall.where.workItemId.in).toEqual(['work-item-1', 'work-item-2'])
    const deleteCall = analysisWorkItemDeleteMany.mock.calls[0][0] as {
      where: { id: { in: string[] } }
    }
    expect(deleteCall.where.id.in).toEqual(['work-item-1', 'work-item-2'])
    // 180日基準の AnalysisRun 削除 (count: 0) + WorkItem に連動した削除 (count: 5)。
    expect(result.deletedAnalysisRunCount).toBe(5)
    expect(analysisWorkItemFindMany).toHaveBeenCalledTimes(1)
  })

  it('削除対象のWorkItemが無ければAnalysisRunの連動削除もWorkItem削除も行わない', async () => {
    const { prisma, analysisWorkItemFindMany, analysisWorkItemDeleteMany } = createMockPrisma({
      eligibleWorkItemIds: [],
    })

    await runRetentionSweep(prisma, new Date('2026-08-08T00:00:00.000Z'))

    expect(analysisWorkItemFindMany).toHaveBeenCalledTimes(1)
    expect(analysisWorkItemDeleteMany).not.toHaveBeenCalled()
  })

  it('OverviewSnapshotを30日より前のgeneratedAtで削除するが、current generationは対象から除く', async () => {
    const { prisma, overviewSnapshotDeleteMany, readModelPointerFindUnique } = createMockPrisma({
      currentGenerationId: 'generation-current',
    })
    const now = new Date('2026-08-08T00:00:00.000Z')

    await runRetentionSweep(prisma, now)

    expect(readModelPointerFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { modelKey: 'overview_snapshot' } }),
    )
    const call = overviewSnapshotDeleteMany.mock.calls[0][0] as {
      where: { generatedAt: { lt: Date }; generationId: { not: string } }
    }
    expect(call.where.generatedAt.lt.toISOString()).toBe('2026-07-09T00:00:00.000Z')
    expect(call.where.generationId.not).toBe('generation-current')
  })

  it('Pointerが未確立でもOverviewSnapshotの削除自体は行う', async () => {
    const { prisma, overviewSnapshotDeleteMany } = createMockPrisma({ currentGenerationId: null })

    await runRetentionSweep(prisma, new Date('2026-08-08T00:00:00.000Z'))

    expect(overviewSnapshotDeleteMany).toHaveBeenCalledTimes(1)
  })

  it('削除件数を集計して返す', async () => {
    const { prisma } = createMockPrisma({ eligibleWorkItemIds: [] })

    const result = await runRetentionSweep(prisma, new Date('2026-08-08T00:00:00.000Z'))

    expect(result).toEqual({
      deletedAnalysisRunCount: 3,
      deletedWorkItemCount: 0,
      deletedLabelMetricSnapshotCount: 1,
      deletedOverviewSnapshotCount: 4,
    })
  })
})
