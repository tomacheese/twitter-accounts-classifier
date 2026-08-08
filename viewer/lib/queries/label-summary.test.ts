import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { listLabelSummaries } from './label-summary'

function createMockPrisma(overrides: { pointer?: unknown; rows?: unknown[]; labels?: unknown[] }) {
  return {
    readModelPointer: { findUnique: vi.fn().mockResolvedValue(overrides.pointer ?? null) },
    labelSummaryCurrent: { findMany: vi.fn().mockResolvedValue(overrides.rows ?? []) },
    labelDefinition: { findMany: vi.fn().mockResolvedValue(overrides.labels ?? []) },
  } as unknown as PrismaClient
}

function makeRow(overrides: Partial<Record<string, unknown>>) {
  return {
    labelDefinitionId: 'label-1',
    prevalence: 0.1,
    qualityStatus: 'stable',
    activeFindingCount: 0,
    highestFindingSeverity: null,
    ...overrides,
  }
}

describe('listLabelSummaries', () => {
  it('ReadModelPointer が無ければ空配列を返す', async () => {
    const prisma = createMockPrisma({})
    expect(await listLabelSummaries(prisma)).toEqual([])
  })

  it('degraded/watch → active Finding → impact → label name の順にソートする', async () => {
    const rows = [
      makeRow({ labelDefinitionId: 'l-stable', qualityStatus: 'stable', prevalence: 0.9 }),
      makeRow({ labelDefinitionId: 'l-degraded', qualityStatus: 'degraded', prevalence: 0.1 }),
      makeRow({
        labelDefinitionId: 'l-watch-finding',
        qualityStatus: 'watch',
        activeFindingCount: 2,
        prevalence: 0.2,
      }),
      makeRow({ labelDefinitionId: 'l-watch', qualityStatus: 'watch', prevalence: 0.3 }),
    ]
    const labels = [
      { id: 'l-stable', key: 'stable-label' },
      { id: 'l-degraded', key: 'degraded-label' },
      { id: 'l-watch-finding', key: 'watch-finding-label' },
      { id: 'l-watch', key: 'watch-label' },
    ]
    const prisma = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      rows,
      labels,
    })

    const result = await listLabelSummaries(prisma)

    expect(result.map((item) => item.labelKey)).toEqual([
      'degraded-label',
      'watch-finding-label',
      'watch-label',
      'stable-label',
    ])
  })
})
