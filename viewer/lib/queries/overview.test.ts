import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getOverviewSnapshot } from './overview'

function createMockPrisma(overrides: { snapshot?: unknown; readModelState?: unknown }) {
  return {
    overviewSnapshot: {
      findUnique: vi.fn().mockResolvedValue(overrides.snapshot ?? null),
    },
    readModelState: {
      findUnique: vi.fn().mockResolvedValue(overrides.readModelState ?? null),
    },
  } as unknown as PrismaClient
}

const baseReadModelState = {
  status: 'healthy',
  currentGenerationId: 'generation-1',
  policyHash: 'hash-1',
}

const baseSnapshot = {
  generationId: 'generation-1',
  operationalStatus: 'healthy',
  qualityStatus: 'stable',
  sourceWatermarkAt: new Date('2026-08-07T00:00:00.000Z'),
  payload: {
    attention: [
      {
        sourceType: 'operational_issue',
        sourceId: 'issue-1',
        category: 'run_failure',
        severity: 'high',
        summary: 'crawl run failed',
        detailHref: '/operations/issue-1',
      },
    ],
    latestPipeline: {
      cycleId: 'cycle-1',
      status: 'succeeded',
      stages: [{ stageKey: 'crawl', status: 'succeeded' }],
    },
  },
}

describe('getOverviewSnapshot', () => {
  it('ReadModelState が無ければ null を返す(current generation が特定できないため)', async () => {
    const prisma = createMockPrisma({})
    expect(await getOverviewSnapshot(prisma)).toBeNull()
  })

  it('current generation の OverviewSnapshot が無ければ null を返す', async () => {
    const prisma = createMockPrisma({ readModelState: baseReadModelState })
    expect(await getOverviewSnapshot(prisma)).toBeNull()
  })

  it('ReadModelState が healthy なら freshnessStatus に healthy を返す', async () => {
    const prisma = createMockPrisma({
      snapshot: baseSnapshot,
      readModelState: baseReadModelState,
    })

    const result = await getOverviewSnapshot(prisma)

    expect(result?.freshnessStatus).toBe('healthy')
    expect(result?.generationId).toBe('generation-1')
    expect(result?.attention).toHaveLength(1)
    expect(result?.latestPipeline?.cycleId).toBe('cycle-1')
  })

  it('ReadModelState が stale でも直近成功 OverviewSnapshot の内容は消さずに返す', async () => {
    const prisma = createMockPrisma({
      snapshot: baseSnapshot,
      readModelState: { ...baseReadModelState, status: 'stale' },
    })

    const result = await getOverviewSnapshot(prisma)

    expect(result?.freshnessStatus).toBe('stale')
    expect(result?.operationalStatus).toBe('healthy')
    expect(result?.attention).toHaveLength(1)
  })

  it('current generation の Pointer を経由して取得する(未公開の build 中 snapshot を見せない)', async () => {
    const prisma = createMockPrisma({ snapshot: baseSnapshot, readModelState: baseReadModelState })

    await getOverviewSnapshot(prisma)

    const findUnique = (
      prisma as unknown as { overviewSnapshot: { findUnique: ReturnType<typeof vi.fn> } }
    ).overviewSnapshot.findUnique
    expect(findUnique.mock.calls[0][0]).toEqual({ where: { generationId: 'generation-1' } })
  })

  it('payload の attention に壊れた要素があればその要素だけ捨てる', async () => {
    const prisma = createMockPrisma({
      snapshot: {
        ...baseSnapshot,
        payload: {
          ...baseSnapshot.payload,
          attention: [...baseSnapshot.payload.attention, { sourceType: 'operational_issue' }, null],
        },
      },
      readModelState: baseReadModelState,
    })

    const result = await getOverviewSnapshot(prisma)

    expect(result?.attention).toHaveLength(1)
  })

  it('payload の latestPipeline が必要なプロパティを欠くなら null にする', async () => {
    const prisma = createMockPrisma({
      snapshot: {
        ...baseSnapshot,
        payload: { ...baseSnapshot.payload, latestPipeline: { cycleId: 'cycle-1' } },
      },
      readModelState: baseReadModelState,
    })

    const result = await getOverviewSnapshot(prisma)

    expect(result?.latestPipeline).toBeNull()
  })

  it('latestPipeline の stages が配列でなければ空配列にする', async () => {
    const prisma = createMockPrisma({
      snapshot: {
        ...baseSnapshot,
        payload: {
          ...baseSnapshot.payload,
          latestPipeline: { cycleId: 'cycle-1', status: 'succeeded', stages: 'broken' },
        },
      },
      readModelState: baseReadModelState,
    })

    const result = await getOverviewSnapshot(prisma)

    expect(result?.latestPipeline?.stages).toEqual([])
  })
})
