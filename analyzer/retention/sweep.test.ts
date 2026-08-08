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
  const detectorEvaluationDeleteMany = vi.fn().mockResolvedValue({ count: 5 })
  const prisma = {
    analysisRun: { deleteMany: analysisRunDeleteMany },
    analysisWorkItem: {
      findMany: analysisWorkItemFindMany,
      deleteMany: analysisWorkItemDeleteMany,
    },
    labelMetricSnapshot: { deleteMany: labelMetricSnapshotDeleteMany },
    readModelPointer: { findUnique: readModelPointerFindUnique },
    overviewSnapshot: { deleteMany: overviewSnapshotDeleteMany },
    detectorEvaluation: { deleteMany: detectorEvaluationDeleteMany },
  } as unknown as PrismaClient
  return {
    prisma,
    analysisRunDeleteMany,
    analysisWorkItemFindMany,
    analysisWorkItemDeleteMany,
    labelMetricSnapshotDeleteMany,
    readModelPointerFindUnique,
    overviewSnapshotDeleteMany,
    detectorEvaluationDeleteMany,
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

  it('succeeded/deadなWorkItemを30日より前のupdatedAtで対象にする (参照中のAnalysisRunの有無は問わない)', async () => {
    const { prisma, analysisWorkItemFindMany } = createMockPrisma()
    const now = new Date('2026-08-08T00:00:00.000Z')

    await runRetentionSweep(prisma, now)

    const call = analysisWorkItemFindMany.mock.calls[0][0] as {
      where: { status: { in: string[] }; updatedAt: { lt: Date } }
    }
    expect(call.where.status.in).toEqual(['succeeded', 'dead'])
    expect(call.where.updatedAt.lt.toISOString()).toBe('2026-07-09T00:00:00.000Z')
    expect(call.where).not.toHaveProperty('runs')
  })

  it('削除対象WorkItemをAnalysisRunの年齢に関わらず削除する (AnalysisRun側はSetNullで残る)', async () => {
    const { prisma, analysisRunDeleteMany, analysisWorkItemFindMany, analysisWorkItemDeleteMany } =
      createMockPrisma({ eligibleWorkItemIds: ['work-item-1', 'work-item-2'] })
    analysisRunDeleteMany.mockResolvedValue({ count: 0 }) // 180日基準の一般 sweep のみ
    analysisWorkItemDeleteMany.mockResolvedValue({ count: 2 })

    const result = await runRetentionSweep(prisma, new Date('2026-08-08T00:00:00.000Z'))

    // AnalysisRun.workItemId は ON DELETE SET NULL のため、WorkItem 削除は
    // AnalysisRun への追加の deleteMany 呼び出しを発生させない。
    expect(analysisRunDeleteMany).toHaveBeenCalledTimes(1)
    const deleteCall = analysisWorkItemDeleteMany.mock.calls[0][0] as {
      where: { id: { in: string[] } }
    }
    expect(deleteCall.where.id.in).toEqual(['work-item-1', 'work-item-2'])
    // 180日基準の AnalysisRun 削除 (count: 0) のみ。WorkItem 削除に連動した削除は無い。
    expect(result.deletedAnalysisRunCount).toBe(0)
    expect(result.deletedWorkItemCount).toBe(2)
    expect(analysisWorkItemFindMany).toHaveBeenCalledTimes(1)
  })

  it('削除対象のWorkItemが無ければWorkItem削除を行わない', async () => {
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

  it('shadowのDetectorEvaluationを30日より前のevaluatedAtで削除し、production判定分は対象にしない', async () => {
    const { prisma, detectorEvaluationDeleteMany } = createMockPrisma()
    const now = new Date('2026-08-08T00:00:00.000Z')

    await runRetentionSweep(prisma, now)

    const call = detectorEvaluationDeleteMany.mock.calls[0][0] as {
      where: { isShadow: boolean; evaluatedAt: { lt: Date } }
    }
    expect(call.where.isShadow).toBe(true)
    expect(call.where.evaluatedAt.lt.toISOString()).toBe('2026-07-09T00:00:00.000Z')
  })

  it('削除件数を集計して返す', async () => {
    const { prisma } = createMockPrisma({ eligibleWorkItemIds: [] })

    const result = await runRetentionSweep(prisma, new Date('2026-08-08T00:00:00.000Z'))

    expect(result).toEqual({
      deletedAnalysisRunCount: 3,
      deletedWorkItemCount: 0,
      deletedLabelMetricSnapshotCount: 1,
      deletedOverviewSnapshotCount: 4,
      deletedShadowDetectorEvaluationCount: 5,
    })
  })
})
