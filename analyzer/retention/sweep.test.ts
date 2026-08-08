import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { runRetentionSweep } from './sweep'

function createMockPrisma() {
  const analysisRunDeleteMany = vi.fn().mockResolvedValue({ count: 3 })
  const analysisWorkItemDeleteMany = vi.fn().mockResolvedValue({ count: 2 })
  const labelMetricSnapshotDeleteMany = vi.fn().mockResolvedValue({ count: 1 })
  const prisma = {
    analysisRun: { deleteMany: analysisRunDeleteMany },
    analysisWorkItem: { deleteMany: analysisWorkItemDeleteMany },
    labelMetricSnapshot: { deleteMany: labelMetricSnapshotDeleteMany },
  } as unknown as PrismaClient
  return {
    prisma,
    analysisRunDeleteMany,
    analysisWorkItemDeleteMany,
    labelMetricSnapshotDeleteMany,
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

  it('完了済みWorkItemを30日より前のupdatedAtで削除するが、参照中のAnalysisRunが残っていれば除外する', async () => {
    const { prisma, analysisWorkItemDeleteMany } = createMockPrisma()
    const now = new Date('2026-08-08T00:00:00.000Z')

    await runRetentionSweep(prisma, now)

    const call = analysisWorkItemDeleteMany.mock.calls[0][0] as {
      where: { status: string; updatedAt: { lt: Date }; runs: { none: Record<string, never> } }
    }
    expect(call.where.status).toBe('succeeded')
    expect(call.where.updatedAt.lt.toISOString()).toBe('2026-07-09T00:00:00.000Z')
    expect(call.where.runs).toEqual({ none: {} })
  })

  it('AnalysisRunを先に削除してからWorkItemを削除する (FK違反を避けるため)', async () => {
    const calls: string[] = []
    const { prisma, analysisRunDeleteMany, analysisWorkItemDeleteMany } = createMockPrisma()
    analysisRunDeleteMany.mockImplementation(() => {
      calls.push('analysisRun')
      return Promise.resolve({ count: 0 })
    })
    analysisWorkItemDeleteMany.mockImplementation(() => {
      calls.push('analysisWorkItem')
      return Promise.resolve({ count: 0 })
    })

    await runRetentionSweep(prisma, new Date('2026-08-08T00:00:00.000Z'))

    expect(calls.indexOf('analysisRun')).toBeLessThan(calls.indexOf('analysisWorkItem'))
  })

  it('削除件数を集計して返す', async () => {
    const { prisma } = createMockPrisma()

    const result = await runRetentionSweep(prisma, new Date('2026-08-08T00:00:00.000Z'))

    expect(result).toEqual({
      deletedAnalysisRunCount: 3,
      deletedWorkItemCount: 2,
      deletedLabelMetricSnapshotCount: 1,
    })
  })
})
