import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getSystemConsoleData } from './system-console'

function createMockPrisma(overrides: {
  snapshot?: unknown
  policy?: unknown
  readModelStates?: unknown[]
  overviewReadModelState?: unknown
}) {
  // snapshot を渡すテストは、それが current generation として公開されている状態を
  // 前提にするため、明示指定が無ければ generationId で対応する ReadModelState を補う。
  const overviewReadModelState =
    overrides.overviewReadModelState ??
    (overrides.snapshot ? { currentGenerationId: 'generation-1' } : null)

  return {
    overviewSnapshot: { findUnique: vi.fn().mockResolvedValue(overrides.snapshot ?? null) },
    detectionPolicyVersion: { findFirst: vi.fn().mockResolvedValue(overrides.policy ?? null) },
    readModelState: {
      findUnique: vi.fn().mockResolvedValue(overviewReadModelState),
      findMany: vi.fn().mockResolvedValue(overrides.readModelStates ?? []),
    },
  } as unknown as PrismaClient
}

describe('getSystemConsoleData', () => {
  it('overview_snapshot の freshness が healthy なら OverviewSnapshot の operationalStatus/qualityStatus をそのまま返す', async () => {
    const snapshot = {
      operationalStatus: 'attention',
      qualityStatus: 'watch',
      sourceWatermarkAt: new Date('2026-08-07T00:00:00.000Z'),
      generatedAt: new Date('2026-08-07T00:05:00.000Z'),
    }
    const prisma = createMockPrisma({ snapshot })

    const data = await getSystemConsoleData(prisma)

    expect(data.componentHealth).toEqual({
      operationalStatus: snapshot.operationalStatus,
      qualityStatus: snapshot.qualityStatus,
      sourceWatermarkAt: snapshot.sourceWatermarkAt,
      generatedAt: snapshot.generatedAt,
    })
  })

  it('overview_snapshot が stale なら componentHealth を critical/unknown で上書きする(analyzer 停止時)', async () => {
    const snapshot = {
      operationalStatus: 'healthy',
      qualityStatus: 'stable',
      sourceWatermarkAt: new Date('2026-08-07T00:00:00.000Z'),
      generatedAt: new Date('2026-08-07T00:05:00.000Z'),
    }
    const prisma = createMockPrisma({
      snapshot,
      overviewReadModelState: {
        currentGenerationId: 'generation-1',
        status: 'healthy',
        lastSuccessAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    })

    const data = await getSystemConsoleData(prisma)

    expect(data.componentHealth?.operationalStatus).toBe('critical')
    expect(data.componentHealth?.qualityStatus).toBe('unknown')
  })

  it('OverviewSnapshot が無ければ componentHealth は null', async () => {
    const prisma = createMockPrisma({})
    const data = await getSystemConsoleData(prisma)
    expect(data.componentHealth).toBeNull()
  })

  it('current generation の Pointer を経由して取得する(generatedAt が新しい superseded snapshot を見せない)', async () => {
    const prisma = createMockPrisma({
      overviewReadModelState: { currentGenerationId: 'generation-1' },
    })

    await getSystemConsoleData(prisma)

    const findUnique = (
      prisma as unknown as { overviewSnapshot: { findUnique: ReturnType<typeof vi.fn> } }
    ).overviewSnapshot.findUnique
    expect(findUnique.mock.calls[0][0]).toEqual({ where: { generationId: 'generation-1' } })
  })

  it('ReadModelState が無ければ overviewSnapshot を問い合わせず componentHealth は null', async () => {
    const prisma = createMockPrisma({ overviewReadModelState: null })

    const data = await getSystemConsoleData(prisma)

    const findUnique = (
      prisma as unknown as { overviewSnapshot: { findUnique: ReturnType<typeof vi.fn> } }
    ).overviewSnapshot.findUnique
    expect(findUnique).not.toHaveBeenCalled()
    expect(data.componentHealth).toBeNull()
  })

  it('errorSummary は先頭 1 行だけを返し、後続行は表示しない', async () => {
    const prisma = createMockPrisma({
      readModelStates: [
        {
          modelKey: 'account_summary',
          status: 'failed',
          schemaVersion: 1,
          lastSuccessAt: null,
          staleAt: null,
          errorSummary:
            'PrismaClientKnownRequestError: query failed\nargs: { screenName: "alice", bio: "..." }',
        },
      ],
    })

    const data = await getSystemConsoleData(prisma)

    expect(data.readModels[0].errorSummary).toBe('PrismaClientKnownRequestError: query failed')
  })

  it('errorSummary は 200 文字を超えたら切り詰める', async () => {
    const prisma = createMockPrisma({
      readModelStates: [
        {
          modelKey: 'account_summary',
          status: 'failed',
          schemaVersion: 1,
          lastSuccessAt: null,
          staleAt: null,
          errorSummary: 'x'.repeat(500),
        },
      ],
    })

    const data = await getSystemConsoleData(prisma)

    expect(data.readModels[0].errorSummary).toBe(`${'x'.repeat(200)}…`)
  })

  it('errorSummary が null なら null のまま返す', async () => {
    const prisma = createMockPrisma({
      readModelStates: [
        {
          modelKey: 'account_summary',
          status: 'healthy',
          schemaVersion: 1,
          lastSuccessAt: null,
          staleAt: null,
          errorSummary: null,
        },
      ],
    })

    const data = await getSystemConsoleData(prisma)

    expect(data.readModels[0].errorSummary).toBeNull()
  })

  it('秘密情報を含む環境変数は allowlist に無ければ含まれない', async () => {
    const original = process.env.DATABASE_URL
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/db'
    try {
      const prisma = createMockPrisma({})
      const data = await getSystemConsoleData(prisma)
      expect(data.diagnosticsEnvVars.some((entry) => entry.key === 'DATABASE_URL')).toBe(false)
    } finally {
      if (original === undefined) {
        delete process.env.DATABASE_URL
      } else {
        process.env.DATABASE_URL = original
      }
    }
  })
})
