import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { listLabelSummaries } from './label-summary'
import { getReadModelReadiness } from '../read-model-meta'

vi.mock('../read-model-meta', () => ({
  getReadModelReadiness: vi.fn(),
}))

function createMockPrisma(overrides: { pointer?: unknown; rows?: unknown[]; labels?: unknown[] }) {
  const labelSummaryFindMany = vi.fn().mockResolvedValue(overrides.rows ?? [])
  const prisma = {
    readModelPointer: { findUnique: vi.fn().mockResolvedValue(overrides.pointer ?? null) },
    labelSummaryCurrent: { findMany: labelSummaryFindMany },
    labelDefinition: { findMany: vi.fn().mockResolvedValue(overrides.labels ?? []) },
  } as unknown as PrismaClient
  return { prisma, labelSummaryFindMany }
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
  it('returns readiness bootstrapping and an empty array without querying LabelSummaryCurrent when labels is not ready', async () => {
    vi.mocked(getReadModelReadiness).mockResolvedValue({
      accounts: 'bootstrapping',
      labels: 'bootstrapping',
    })
    const { prisma, labelSummaryFindMany } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
    })

    const result = await listLabelSummaries(prisma)

    expect(result).toEqual({ items: [], readiness: 'bootstrapping' })
    expect(labelSummaryFindMany).not.toHaveBeenCalled()
  })

  it('ReadModelPointer が無ければ空配列を返す', async () => {
    vi.mocked(getReadModelReadiness).mockResolvedValue({ accounts: 'ready', labels: 'ready' })
    const { prisma } = createMockPrisma({})
    const result = await listLabelSummaries(prisma)
    expect(result).toEqual({ items: [], readiness: 'ready' })
  })

  it('degraded/watch → active Finding → impact → label name の順にソートする', async () => {
    vi.mocked(getReadModelReadiness).mockResolvedValue({ accounts: 'ready', labels: 'ready' })
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
    const { prisma } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      rows,
      labels,
    })

    const result = await listLabelSummaries(prisma)

    expect(result.readiness).toBe('ready')
    expect(result.items.map((item) => item.labelKey)).toEqual([
      'degraded-label',
      'watch-finding-label',
      'watch-label',
      'stable-label',
    ])
  })
})
