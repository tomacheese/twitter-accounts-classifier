import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getFindingRawArtifacts, getReviewFindingDetail } from './review-finding-detail'

function createMockPrisma(overrides: { finding?: unknown; artifacts?: unknown[] }) {
  const findUnique = vi.fn().mockResolvedValue(overrides.finding ?? null)
  const artifactFindMany = vi.fn().mockResolvedValue(overrides.artifacts ?? [])
  const prisma = {
    reviewFinding: { findUnique },
    findingRawArtifact: { findMany: artifactFindMany },
  } as unknown as PrismaClient
  return { prisma, findUnique, artifactFindMany }
}

const observedAt = new Date('2026-01-05T00:00:00Z')
const createdAt = new Date('2026-01-06T00:00:00Z')

const finding = {
  id: 'finding-1',
  type: 'label_count_drop',
  status: 'active',
  currentSeverity: 'high',
  maximumSeverity: 'critical',
  primaryScopeType: 'label',
  primaryScopeId: 'label-1',
  firstDetectedAt: new Date('2026-01-01T00:00:00Z'),
  lastDetectedAt: observedAt,
  resolvedAt: null,
  recurrenceCount: 1,
  occurrences: [
    {
      id: 'occurrence-1',
      observedAt,
      stateTransition: 'none_to_active',
      severity: 'high',
      observedValue: 0.1,
      baselineValue: 0.3,
      affectedCount: 5,
      totalCount: 50,
      affectedRatio: 0.1,
    },
  ],
  evidences: [{ id: 'evidence-1', kind: 'metric', payload: { note: 'fictional' }, createdAt }],
}

describe('getReviewFindingDetail', () => {
  it('Finding が無ければ null を返す', async () => {
    const { prisma } = createMockPrisma({})
    expect(await getReviewFindingDetail(prisma, 'finding-1')).toBeNull()
  })

  it('Occurrence と Evidence を含む詳細を返す', async () => {
    const { prisma } = createMockPrisma({ finding })

    const result = await getReviewFindingDetail(prisma, 'finding-1')

    expect(result).toMatchObject({ id: 'finding-1', currentSeverity: 'high', recurrenceCount: 1 })
    expect(result?.occurrences).toHaveLength(1)
    expect(result?.occurrences[0]).toMatchObject({ id: 'occurrence-1', severity: 'high' })
    expect(result?.evidences[0]).toMatchObject({ id: 'evidence-1', kind: 'metric' })
  })

  it('Occurrence は新しい順に上限件数まで取得する', async () => {
    const { prisma, findUnique } = createMockPrisma({ finding })

    await getReviewFindingDetail(prisma, 'finding-1')

    const call = findUnique.mock.calls[0][0] as {
      include: { occurrences: { take: number; orderBy: { observedAt?: string }[] } }
    }
    expect(call.include.occurrences.take).toBe(10)
    expect(call.include.occurrences.orderBy[0]).toEqual({ observedAt: 'desc' })
  })

  it('Raw Analysis は詳細取得のクエリに含めない', async () => {
    const { prisma, artifactFindMany } = createMockPrisma({ finding })

    await getReviewFindingDetail(prisma, 'finding-1')

    expect(artifactFindMany).not.toHaveBeenCalled()
  })
})

describe('getFindingRawArtifacts', () => {
  it('対象 Finding の Raw Analysis を新しい順に返す', async () => {
    const artifacts = [
      { id: 'artifact-1', kind: 'llm_response', content: '{}', isTruncated: false, createdAt },
    ]
    const { prisma, artifactFindMany } = createMockPrisma({ artifacts })

    expect(await getFindingRawArtifacts(prisma, 'finding-1')).toEqual(artifacts)
    expect(artifactFindMany).toHaveBeenCalledWith({
      where: { findingId: 'finding-1' },
      orderBy: [{ createdAt: 'desc' }],
    })
  })
})
