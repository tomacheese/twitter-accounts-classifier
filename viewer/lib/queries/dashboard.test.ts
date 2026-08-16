import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getReadModelReadiness } from '../read-model-meta'
import { listLabelSummaries } from './label-summary'

vi.mock('../read-model-meta', () => ({ getReadModelReadiness: vi.fn() }))
vi.mock('./label-summary', () => ({ listLabelSummaries: vi.fn() }))

function createMockPrisma(options: { counter?: { labeledAccounts: number } | null }) {
  const prisma = {
    account: {
      count: vi.fn().mockResolvedValue(120),
      aggregate: vi
        .fn()
        .mockResolvedValue({ _max: { lastCrawledAt: new Date('2026-07-27T00:00:00Z') } }),
    },
    tweet: { count: vi.fn().mockResolvedValue(4500) },
    labeledAccountCounter: {
      findUnique: vi.fn().mockResolvedValue(options.counter ?? null),
    },
  } as unknown as PrismaClient & {
    account: { count: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> }
    tweet: { count: ReturnType<typeof vi.fn> }
    labeledAccountCounter: { findUnique: ReturnType<typeof vi.fn> }
  }
  return prisma
}

function makeSummaryItem(overrides: Partial<Record<string, unknown>>) {
  return {
    labelDefinitionId: 'label-1',
    labelKey: 'spam',
    labelDescription: 'Likely spam account',
    evaluatedCount: 120,
    trueCount: 7,
    populationCount: 120,
    coverage: 1,
    prevalence: 0.058,
    qualityStatus: 'stable',
    activeFindingCount: 0,
    highestFindingSeverity: null,
    ...overrides,
  }
}

// テストからは Prisma を差し替えられる形で呼ぶためのラッパー。
// 実体は本ファイル冒頭の import から差し替わる `./dashboard` を直接使う。
async function getDashboardKpisFor(prisma: PrismaClient) {
  const { getDashboardKpis } = await import('./dashboard')
  return getDashboardKpis(prisma)
}
async function getLabelDistributionFor() {
  const { getLabelDistribution } = await import('./dashboard')
  return getLabelDistribution({} as PrismaClient)
}
async function getTopLabelOverviewFor(limit: number) {
  const { getTopLabelOverview } = await import('./dashboard')
  return getTopLabelOverview({} as PrismaClient, limit)
}

describe('getDashboardKpis', () => {
  it('aggregates account/tweet counts, labeled account count, and last crawl time when accounts read model is ready', async () => {
    vi.mocked(getReadModelReadiness).mockResolvedValue({ accounts: 'ready', labels: 'ready' })
    const prisma = createMockPrisma({ counter: { labeledAccounts: 42 } })

    const result = await getDashboardKpisFor(prisma)

    expect(result).toEqual({
      totalAccounts: 120,
      totalTweets: 4500,
      labeledAccounts: 42,
      lastCrawledAt: new Date('2026-07-27T00:00:00Z'),
    })
  })

  it('returns null labeled accounts while the read model is not ready yet', async () => {
    vi.mocked(getReadModelReadiness).mockResolvedValue({
      accounts: 'bootstrapping',
      labels: 'bootstrapping',
    })
    const prisma = createMockPrisma({ counter: { labeledAccounts: 42 } })

    const result = await getDashboardKpisFor(prisma)

    expect(result.labeledAccounts).toBeNull()
  })

  it('returns 0 labeled accounts when the read model is ready but LabeledAccountCounter has never been written', async () => {
    vi.mocked(getReadModelReadiness).mockResolvedValue({ accounts: 'ready', labels: 'ready' })
    const prisma = createMockPrisma({ counter: null })
    prisma.account.count.mockResolvedValue(0)
    prisma.tweet.count.mockResolvedValue(0)
    prisma.account.aggregate.mockResolvedValue({ _max: { lastCrawledAt: null } })

    const result = await getDashboardKpisFor(prisma)

    expect(result.labeledAccounts).toBe(0)
    expect(result.lastCrawledAt).toBeNull()
  })
})

describe('getLabelDistribution', () => {
  it('maps listLabelSummaries entries into distribution entries sorted by labelKey', async () => {
    vi.mocked(listLabelSummaries).mockResolvedValue({
      readiness: 'ready',
      items: [
        makeSummaryItem({
          labelKey: 'topic_tech',
          labelDescription: 'Tech',
          trueCount: 5,
          evaluatedCount: 100,
        }),
        makeSummaryItem({
          labelKey: 'blue_verified',
          labelDescription: 'Verified',
          trueCount: 20,
          evaluatedCount: 100,
        }),
      ],
    })

    const result = await getLabelDistributionFor()

    expect(result).toEqual([
      {
        labelKey: 'blue_verified',
        labelDescription: 'Verified',
        trueCount: 20,
        totalAccounts: 100,
      },
      { labelKey: 'topic_tech', labelDescription: 'Tech', trueCount: 5, totalAccounts: 100 },
    ])
  })

  it('returns an empty array while the read model is not ready', async () => {
    vi.mocked(listLabelSummaries).mockResolvedValue({ readiness: 'bootstrapping', items: [] })

    const result = await getLabelDistributionFor()

    expect(result).toEqual([])
  })
})

describe('getTopLabelOverview', () => {
  it('returns entries sorted by trueCount descending, limited to the given count', async () => {
    vi.mocked(listLabelSummaries).mockResolvedValue({
      readiness: 'ready',
      items: [
        makeSummaryItem({ labelKey: 'topic_tech', trueCount: 5 }),
        makeSummaryItem({ labelKey: 'blue_verified', trueCount: 20 }),
        makeSummaryItem({ labelKey: 'topic_finance', trueCount: 12 }),
      ],
    })

    const entries = await getTopLabelOverviewFor(2)

    expect(entries.map((entry) => entry.labelKey)).toEqual(['blue_verified', 'topic_finance'])
  })
})
