import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getSystemConsoleData } from './system-console'

function createMockPrisma(overrides: {
  snapshot?: unknown
  policy?: unknown
  readModelStates?: unknown[]
}) {
  return {
    overviewSnapshot: { findFirst: vi.fn().mockResolvedValue(overrides.snapshot ?? null) },
    detectionPolicyVersion: { findFirst: vi.fn().mockResolvedValue(overrides.policy ?? null) },
    readModelState: { findMany: vi.fn().mockResolvedValue(overrides.readModelStates ?? []) },
  } as unknown as PrismaClient
}

describe('getSystemConsoleData', () => {
  it('Component health は OverviewSnapshot の operationalStatus/qualityStatus をそのまま返す (別計算しない)', async () => {
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

  it('OverviewSnapshot が無ければ componentHealth は null', async () => {
    const prisma = createMockPrisma({})
    const data = await getSystemConsoleData(prisma)
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
