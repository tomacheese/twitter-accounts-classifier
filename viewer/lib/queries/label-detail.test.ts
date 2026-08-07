import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getLabelDetail } from './label-detail'

interface MockData {
  labelDefinition?: unknown
  latestSnapshot?: unknown
  dailyRows?: unknown[]
  findings?: unknown[]
}

function createMockPrisma(data: MockData) {
  const dailyFindMany = vi.fn().mockResolvedValue(data.dailyRows ?? [])
  const prisma = {
    labelDefinition: { findUnique: vi.fn().mockResolvedValue(data.labelDefinition ?? null) },
    labelMetricSnapshot: { findFirst: vi.fn().mockResolvedValue(data.latestSnapshot ?? null) },
    labelMetricDaily: { findMany: dailyFindMany },
    reviewFinding: { findMany: vi.fn().mockResolvedValue(data.findings ?? []) },
  } as unknown as PrismaClient
  return { prisma, dailyFindMany }
}

const labelDefinition = { id: 'label-1', key: 'spam', description: 'A fictional label.' }

describe('getLabelDetail', () => {
  it('LabelDefinition が無ければ null を返す', async () => {
    const { prisma } = createMockPrisma({})
    expect(await getLabelDetail(prisma, 'unknown-key')).toBeNull()
  })

  it('最新 snapshot・トレンド・active Finding をまとめて返す', async () => {
    const observedAt = new Date('2026-01-05T00:00:00Z')
    const date = new Date('2026-01-04T00:00:00Z')
    const { prisma } = createMockPrisma({
      labelDefinition,
      latestSnapshot: { prevalence: 0.25, evaluatedCount: 400, trueCount: 100, observedAt },
      dailyRows: [{ date, prevalence: 0.2, evaluatedCount: 300, trueCount: 60 }],
      findings: [{ id: 'finding-1', type: 'label_count_drop', currentSeverity: 'high' }],
    })

    const result = await getLabelDetail(prisma, 'spam')

    expect(result).toEqual({
      labelKey: 'spam',
      description: 'A fictional label.',
      latestSnapshot: { prevalence: 0.25, evaluatedCount: 400, trueCount: 100, observedAt },
      trend: [{ date, prevalence: 0.2, evaluatedCount: 300, trueCount: 60 }],
      activeFindings: [
        { findingId: 'finding-1', type: 'label_count_drop', currentSeverity: 'high' },
      ],
    })
  })

  it('snapshot が 1 件も無ければ latestSnapshot は null になる', async () => {
    const { prisma } = createMockPrisma({ labelDefinition })

    const result = await getLabelDetail(prisma, 'spam')

    expect(result?.latestSnapshot).toBeNull()
    expect(result?.trend).toEqual([])
  })

  it('range preset が短いほどトレンドの取得開始日時が新しくなる', async () => {
    const { prisma: prisma24h, dailyFindMany: find24h } = createMockPrisma({ labelDefinition })
    const { prisma: prisma90d, dailyFindMany: find90d } = createMockPrisma({ labelDefinition })

    await getLabelDetail(prisma24h, 'spam', { range: '24h' })
    await getLabelDetail(prisma90d, 'spam', { range: '90d' })

    const since24h = (find24h.mock.calls[0][0] as { where: { date: { gte: Date } } }).where.date.gte
    const since90d = (find90d.mock.calls[0][0] as { where: { date: { gte: Date } } }).where.date.gte
    expect(since24h.getTime()).toBeGreaterThan(since90d.getTime())
  })
})
