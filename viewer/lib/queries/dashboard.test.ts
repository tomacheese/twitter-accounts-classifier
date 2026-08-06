import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'

function createMockPrisma(options: {
  labelAggregateRows?: {
    labelKey: string
    labelDescription: string
    trueCount: number
    totalCount: number
  }[]
  status?: {
    labeledAccounts: number
    lastSuccessAt: Date | null
    lastAttemptStatus: string
  } | null
}) {
  return {
    account: {
      count: vi.fn().mockResolvedValue(120),
      aggregate: vi
        .fn()
        .mockResolvedValue({ _max: { lastCrawledAt: new Date('2026-07-27T00:00:00Z') } }),
    },
    tweet: { count: vi.fn().mockResolvedValue(4500) },
    labelAggregate: {
      findMany: vi.fn().mockResolvedValue(options.labelAggregateRows ?? []),
    },
    labelAggregateStatus: {
      findUnique: vi.fn().mockResolvedValue(options.status ?? null),
    },
  } as unknown as PrismaClient & {
    account: { count: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> }
    tweet: { count: ReturnType<typeof vi.fn> }
    labelAggregate: { findMany: ReturnType<typeof vi.fn> }
    labelAggregateStatus: { findUnique: ReturnType<typeof vi.fn> }
  }
}

describe('getLabelAggregateSnapshot', () => {
  it('maps LabelAggregate rows and LabelAggregateStatus into a snapshot', async () => {
    const { getLabelAggregateSnapshot } = await import('./dashboard')
    const prisma = createMockPrisma({
      labelAggregateRows: [
        {
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          trueCount: 7,
          totalCount: 120,
        },
      ],
      status: {
        labeledAccounts: 42,
        lastSuccessAt: new Date('2026-08-05T00:00:00Z'),
        lastAttemptStatus: 'success',
      },
    })

    const result = await getLabelAggregateSnapshot(prisma)

    expect(result).toEqual({
      labeledAccounts: 42,
      distribution: [
        {
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          trueCount: 7,
          totalAccounts: 120,
        },
      ],
      lastSuccessAt: new Date('2026-08-05T00:00:00Z'),
      lastAttemptStatus: 'success',
    })
  })

  it('returns default zero values when LabelAggregateStatus has never been written', async () => {
    const { getLabelAggregateSnapshot } = await import('./dashboard')
    const prisma = createMockPrisma({ labelAggregateRows: [], status: null })

    const result = await getLabelAggregateSnapshot(prisma)

    expect(result).toEqual({
      labeledAccounts: 0,
      distribution: [],
      lastSuccessAt: null,
      lastAttemptStatus: null,
    })
  })
})

describe('getDashboardKpis', () => {
  it('aggregates account/tweet counts, labeled account count, and last crawl time', async () => {
    const { getDashboardKpis } = await import('./dashboard')
    const prisma = createMockPrisma({
      status: {
        labeledAccounts: 42,
        lastSuccessAt: new Date('2026-08-05T00:00:00Z'),
        lastAttemptStatus: 'success',
      },
    })

    const result = await getDashboardKpis(prisma)

    expect(result).toEqual({
      totalAccounts: 120,
      totalTweets: 4500,
      labeledAccounts: 42,
      lastCrawledAt: new Date('2026-07-27T00:00:00Z'),
    })
  })

  it('returns 0 labeled accounts when LabelAggregateStatus has never been written', async () => {
    const { getDashboardKpis } = await import('./dashboard')
    const prisma = createMockPrisma({ status: null })
    prisma.account.count.mockResolvedValue(0)
    prisma.tweet.count.mockResolvedValue(0)
    prisma.account.aggregate.mockResolvedValue({ _max: { lastCrawledAt: null } })

    const result = await getDashboardKpis(prisma)

    expect(result.labeledAccounts).toBe(0)
    expect(result.lastCrawledAt).toBeNull()
  })
})

describe('getLabelDistribution', () => {
  it('maps raw rows into typed distribution entries', async () => {
    const { getLabelDistribution } = await import('./dashboard')
    const prisma = createMockPrisma({
      labelAggregateRows: [
        {
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          trueCount: 7,
          totalCount: 120,
        },
      ],
    })

    const result = await getLabelDistribution(prisma)

    expect(result).toEqual([
      {
        labelKey: 'spam',
        labelDescription: 'Likely spam account',
        trueCount: 7,
        totalAccounts: 120,
      },
    ])
  })

  it('includes a label definition with zero evaluations as 0/0', async () => {
    const { getLabelDistribution } = await import('./dashboard')
    const prisma = createMockPrisma({
      labelAggregateRows: [
        {
          labelKey: 'new-label',
          labelDescription: 'Not yet evaluated by any crawl',
          trueCount: 0,
          totalCount: 0,
        },
      ],
    })

    const result = await getLabelDistribution(prisma)

    expect(result).toEqual([
      {
        labelKey: 'new-label',
        labelDescription: 'Not yet evaluated by any crawl',
        trueCount: 0,
        totalAccounts: 0,
      },
    ])
  })
})

describe('getTopLabelOverview', () => {
  it('returns entries sorted by trueCount descending, limited to the given count', async () => {
    const { getTopLabelOverview } = await import('./dashboard')
    const prisma = createMockPrisma({
      labelAggregateRows: [
        { labelKey: 'topic_tech', labelDescription: 'Tech', trueCount: 5, totalCount: 100 },
        { labelKey: 'blue_verified', labelDescription: 'Verified', trueCount: 20, totalCount: 100 },
        { labelKey: 'topic_finance', labelDescription: 'Finance', trueCount: 12, totalCount: 100 },
      ],
    })

    const entries = await getTopLabelOverview(prisma, 2)

    expect(entries.map((entry) => entry.labelKey)).toEqual(['blue_verified', 'topic_finance'])
  })
})
