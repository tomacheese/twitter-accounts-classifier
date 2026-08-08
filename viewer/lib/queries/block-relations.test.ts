import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getBlockRelationDetail, listBlockRelations } from './block-relations'

function createMockPrisma(overrides: {
  pointer?: unknown
  rows?: unknown[]
  block?: unknown
  timeline?: unknown[]
  findingLinks?: unknown[]
}) {
  const findMany = vi.fn().mockResolvedValue(overrides.rows ?? [])
  const operationCycleFindFirst = vi.fn().mockResolvedValue(null)
  return {
    prisma: {
      readModelPointer: { findUnique: vi.fn().mockResolvedValue(overrides.pointer ?? null) },
      blockRelationCurrent: { findMany },
      block: { findUnique: vi.fn().mockResolvedValue(overrides.block ?? null) },
      blockStateChange: { findMany: vi.fn().mockResolvedValue(overrides.timeline ?? []) },
      operationCycle: { findFirst: operationCycleFindFirst },
      findingEntityLink: { findMany: vi.fn().mockResolvedValue(overrides.findingLinks ?? []) },
    } as unknown as PrismaClient,
    findMany,
    operationCycleFindFirst,
  }
}

describe('listBlockRelations', () => {
  it('ReadModelPointer が無ければ空配列を返す', async () => {
    const { prisma } = createMockPrisma({})
    expect(await listBlockRelations(prisma)).toEqual({
      items: [],
      nextCursor: null,
      generationId: null,
    })
  })

  it("status: 'active' が既定 filter", async () => {
    const { prisma, findMany } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      rows: [],
    })
    await listBlockRelations(prisma)
    const call = findMany.mock.calls[0][0] as { where: { status: string } }
    expect(call.where.status).toBe('active')
  })
})

const baseBlock = {
  id: 'block-1',
  blocker: { id: 'account-blocker', screenName: 'alice', displayName: 'Alice' },
  blocked: { id: 'account-blocked', screenName: 'bob', displayName: 'Bob' },
  status: 'active',
  firstSeenAt: new Date('2026-08-01T00:00:00.000Z'),
  lastSeenAt: new Date('2026-08-07T00:00:00.000Z'),
  lastCheckedAt: new Date('2026-08-07T00:00:00.000Z'),
  missingSinceAt: null,
  resolvedAt: null,
  consecutiveMissingCount: 0,
  sourceKind: 'legacy',
}

describe('getBlockRelationDetail', () => {
  it('存在しない Block は null を返す', async () => {
    const { prisma } = createMockPrisma({ block: null })
    expect(await getBlockRelationDetail(prisma, 'missing')).toBeNull()
  })

  it('Timeline は最新 10 件のみ初期取得する', async () => {
    const timeline = Array.from({ length: 3 }, (_, index) => ({
      id: `change-${index}`,
      fromStatus: 'active',
      toStatus: 'missing',
      changedAt: new Date('2026-08-07T00:00:00.000Z'),
    }))
    const prismaMock = createMockPrisma({ block: baseBlock, timeline })
    const detail = await getBlockRelationDetail(prismaMock.prisma, 'block-1')

    const blockStateChangeFindMany = (
      prismaMock.prisma as unknown as {
        blockStateChange: { findMany: ReturnType<typeof vi.fn> }
      }
    ).blockStateChange.findMany
    const call = blockStateChangeFindMany.mock.calls[0][0] as { take: number }
    expect(call.take).toBe(10)
    expect(detail?.timeline).toHaveLength(3)
  })

  it('Block と対応付けられない OperationCycle は取得しない', async () => {
    const prismaMock = createMockPrisma({ block: baseBlock })
    const detail = await getBlockRelationDetail(prismaMock.prisma, 'block-1')

    expect(prismaMock.operationCycleFindFirst).not.toHaveBeenCalled()
    expect(detail).not.toHaveProperty('relatedOperationCycle')
  })
})
