import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getOverviewSnapshot } from './overview'

function createMockPrisma(overrides: { snapshot?: unknown; readModelState?: unknown }) {
  return {
    overviewSnapshot: {
      findFirst: vi.fn().mockResolvedValue(overrides.snapshot ?? null),
    },
    readModelState: {
      findUnique: vi.fn().mockResolvedValue(overrides.readModelState ?? null),
    },
  } as unknown as PrismaClient
}

const baseSnapshot = {
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
  it('OverviewSnapshot が無ければ null を返す', async () => {
    const prisma = createMockPrisma({})
    expect(await getOverviewSnapshot(prisma)).toBeNull()
  })

  it('ReadModelState が healthy なら freshnessStatus に healthy を返す', async () => {
    const prisma = createMockPrisma({
      snapshot: baseSnapshot,
      readModelState: {
        status: 'healthy',
        currentGenerationId: 'generation-1',
        policyHash: 'hash-1',
      },
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
      readModelState: {
        status: 'stale',
        currentGenerationId: 'generation-1',
        policyHash: 'hash-1',
      },
    })

    const result = await getOverviewSnapshot(prisma)

    expect(result?.freshnessStatus).toBe('stale')
    expect(result?.operationalStatus).toBe('healthy')
    expect(result?.attention).toHaveLength(1)
  })

  it('ReadModelState が無ければ freshnessStatus は unknown になる', async () => {
    const prisma = createMockPrisma({ snapshot: baseSnapshot })

    const result = await getOverviewSnapshot(prisma)

    expect(result?.freshnessStatus).toBe('unknown')
  })

  it('索引のある generatedAt で最新 snapshot を選ぶ', async () => {
    const prisma = createMockPrisma({ snapshot: baseSnapshot })

    await getOverviewSnapshot(prisma)

    const findFirst = (
      prisma as unknown as { overviewSnapshot: { findFirst: ReturnType<typeof vi.fn> } }
    ).overviewSnapshot.findFirst
    expect(findFirst.mock.calls[0][0]).toEqual({ orderBy: [{ generatedAt: 'desc' }] })
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
    })

    const result = await getOverviewSnapshot(prisma)

    expect(result?.latestPipeline?.stages).toEqual([])
  })
})
