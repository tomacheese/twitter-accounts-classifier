import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import {
  getCrawlCycleDetail,
  getWeeklyReviewCycleDetail,
  isAttentionRequiredStatus,
  listOperationCycles,
} from './operation-cycles'

function createMockPrisma(overrides: { cycles?: unknown[]; cycle?: unknown }) {
  const findMany = vi.fn().mockResolvedValue(overrides.cycles ?? [])
  const findUnique = vi.fn().mockResolvedValue(overrides.cycle ?? null)
  const prisma = { operationCycle: { findMany, findUnique } } as unknown as PrismaClient
  return { prisma, findMany, findUnique }
}

describe('isAttentionRequiredStatus', () => {
  it('partial/failed/stale/unknown を含む', () => {
    expect(isAttentionRequiredStatus('partial')).toBe(true)
    expect(isAttentionRequiredStatus('failed')).toBe(true)
    expect(isAttentionRequiredStatus('stale')).toBe(true)
    expect(isAttentionRequiredStatus('unknown')).toBe(true)
  })

  it('succeeded は含まない', () => {
    expect(isAttentionRequiredStatus('succeeded')).toBe(false)
  })
})

describe('listOperationCycles', () => {
  it('既定で 30 件まで取得する', async () => {
    const { prisma, findMany } = createMockPrisma({ cycles: [] })
    await listOperationCycles(prisma)
    const call = findMany.mock.calls[0][0] as { take: number }
    expect(call.take).toBe(30)
  })
})

const baseCycle = {
  id: 'cycle-1',
  kind: 'crawl',
  status: 'succeeded',
  attentionRequired: false,
  triggeredAt: new Date('2026-08-07T00:00:00.000Z'),
  startedAt: new Date('2026-08-07T00:00:01.000Z'),
  finishedAt: new Date('2026-08-07T00:10:00.000Z'),
  stages: [
    {
      stageKey: 'label_metrics',
      sequence: 1,
      requiredness: 'required',
      status: 'succeeded',
      startedAt: null,
      finishedAt: null,
      errorSummary: null,
    },
    {
      stageKey: 'crawl',
      sequence: 0,
      requiredness: 'required',
      status: 'succeeded',
      startedAt: null,
      finishedAt: null,
      errorSummary: null,
    },
  ],
}

describe('getCrawlCycleDetail', () => {
  it('kind: crawl の Cycle 詳細を Stage timeline とともに返す (sequence 順は DB の orderBy が保証する)', async () => {
    const { prisma, findUnique } = createMockPrisma({ cycle: baseCycle })
    const detail = await getCrawlCycleDetail(prisma, 'cycle-1')

    const call = findUnique.mock.calls[0][0] as { include: { stages: { orderBy: unknown[] } } }
    expect(call.include.stages.orderBy).toEqual([{ sequence: 'asc' }])
    expect(detail?.stages).toHaveLength(2)
  })

  it('kind が一致しなければ null を返す', async () => {
    const { prisma } = createMockPrisma({ cycle: { ...baseCycle, kind: 'block' } })
    expect(await getCrawlCycleDetail(prisma, 'cycle-1')).toBeNull()
  })
})

describe('getWeeklyReviewCycleDetail', () => {
  it('kind: weekly_review でなければ null を返す', async () => {
    const { prisma } = createMockPrisma({ cycle: baseCycle })
    expect(await getWeeklyReviewCycleDetail(prisma, 'cycle-1')).toBeNull()
  })
})
