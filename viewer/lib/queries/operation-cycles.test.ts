import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import {
  getBlockCycleDetail,
  getCrawlCycleDetail,
  getWeeklyReviewCycleDetail,
  listOperationCycles,
} from './operation-cycles'

function createMockPrisma(overrides: {
  cycles?: unknown[]
  cycle?: unknown
  blockAccountRuns?: unknown[]
  weeklyAnalysisRun?: unknown
}) {
  const findMany = vi.fn().mockResolvedValue(overrides.cycles ?? [])
  const findUnique = vi.fn().mockResolvedValue(overrides.cycle ?? null)
  const queryRaw = vi.fn().mockResolvedValue(overrides.blockAccountRuns ?? [])
  const weeklyAnalysisRunFindUnique = vi.fn().mockResolvedValue(overrides.weeklyAnalysisRun ?? null)
  const prisma = {
    operationCycle: { findMany, findUnique },
    weeklyAnalysisRun: { findUnique: weeklyAnalysisRunFindUnique },
    $queryRaw: queryRaw,
  } as unknown as PrismaClient
  return { prisma, findMany, findUnique, queryRaw, weeklyAnalysisRunFindUnique }
}

describe('listOperationCycles', () => {
  it('一覧に currentStageKey を含める', async () => {
    const row = {
      id: 'cycle-1',
      kind: 'crawl',
      status: 'running',
      attentionRequired: false,
      triggeredAt: new Date('2026-08-08T00:00:00Z'),
      startedAt: new Date('2026-08-08T00:00:01Z'),
      finishedAt: null,
      currentStageKey: 'label_metrics',
    }
    const { prisma } = createMockPrisma({ cycles: [row] })

    const result = await listOperationCycles(prisma)

    expect(result.items[0]?.currentStageKey).toBe('label_metrics')
  })

  it('既定で 30 件まで取得する', async () => {
    const { prisma, findMany } = createMockPrisma({ cycles: [] })
    await listOperationCycles(prisma)
    const call = findMany.mock.calls[0][0] as { take: number }
    // 次ページの有無を判定するため、既定件数より 1 件多く取得する。
    expect(call.take).toBe(31)
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
  sourceId: 'crawl-run-1',
  stages: [
    {
      stageKey: 'label_metrics',
      sequence: 1,
      requiredness: 'required',
      status: 'succeeded',
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorSummary: null,
    },
    {
      stageKey: 'crawl',
      sequence: 0,
      requiredness: 'required',
      status: 'succeeded',
      startedAt: null,
      finishedAt: null,
      errorCode: null,
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

  it('sourceId から WeeklyAnalysisRun.findings を取得して返す', async () => {
    const cycle = { ...baseCycle, kind: 'weekly_review', sourceId: 'weekly-run-1' }
    const { prisma, weeklyAnalysisRunFindUnique } = createMockPrisma({
      cycle,
      weeklyAnalysisRun: { findings: '週次レビューの日本語サマリ' },
    })

    const detail = await getWeeklyReviewCycleDetail(prisma, 'cycle-1')

    expect(detail?.findings).toBe('週次レビューの日本語サマリ')
    expect(weeklyAnalysisRunFindUnique.mock.calls[0]?.[0]).toEqual({
      where: { id: 'weekly-run-1' },
      select: { findings: true },
    })
  })

  it('WeeklyAnalysisRun が見つからない、または findings が null なら null を返す', async () => {
    const cycle = { ...baseCycle, kind: 'weekly_review', sourceId: 'weekly-run-1' }
    const { prisma } = createMockPrisma({ cycle })

    const detail = await getWeeklyReviewCycleDetail(prisma, 'cycle-1')

    expect(detail?.findings).toBeNull()
  })
})

describe('getBlockCycleDetail', () => {
  it('BlockRun sourceId から username ごとの最新 BlockAccountRun 内訳を返す', async () => {
    const cycle = {
      ...baseCycle,
      kind: 'block',
      sourceType: 'block_run',
      sourceId: 'block-run-1',
    }
    const latestAccountRuns = [
      {
        id: 'account-run-alice-latest',
        username: 'alice',
        status: 'completed',
        startedAt: new Date('2026-08-07T00:01:00.000Z'),
        finishedAt: new Date('2026-08-07T00:02:00.000Z'),
        candidatesCount: 12,
        blockedCount: 10,
        failedCount: 2,
        errorMessage: null,
      },
    ]
    const { prisma, queryRaw } = createMockPrisma({
      cycle,
      blockAccountRuns: latestAccountRuns,
    })

    const detail = await getBlockCycleDetail(prisma, 'cycle-1')

    expect(detail?.accountRuns).toEqual(latestAccountRuns)
    expect(queryRaw).toHaveBeenCalledOnce()
    expect(queryRaw.mock.calls[0]?.[1]).toBe('block-run-1')
    const sql = (queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('')
    expect(sql).toContain('DISTINCT ON ("username")')
    expect(sql).toContain('"startedAt" DESC, "id" DESC')
  })
})
