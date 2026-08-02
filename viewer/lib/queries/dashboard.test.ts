import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'

interface MockRow {
  labeledAccounts: bigint
  distribution: {
    labelKey: string
    labelDescription: string
    trueCount: number
    totalAccounts: number
  }[]
}

function createMockPrisma(rows: MockRow[]) {
  return {
    account: {
      count: vi.fn().mockResolvedValue(120),
      aggregate: vi
        .fn()
        .mockResolvedValue({ _max: { lastCrawledAt: new Date('2026-07-27T00:00:00Z') } }),
    },
    tweet: { count: vi.fn().mockResolvedValue(4500) },
    $transaction: vi.fn().mockResolvedValue([undefined, rows]),
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn(),
  } as unknown as PrismaClient & {
    account: { count: ReturnType<typeof vi.fn>; aggregate: ReturnType<typeof vi.fn> }
    tweet: { count: ReturnType<typeof vi.fn> }
    $transaction: ReturnType<typeof vi.fn>
    $executeRaw: ReturnType<typeof vi.fn>
  }
}

const SAMPLE_ROW: MockRow = {
  labeledAccounts: 42n,
  distribution: [
    { labelKey: 'spam', labelDescription: 'Likely spam account', trueCount: 7, totalAccounts: 120 },
  ],
}

// getLatestLabelsSummary はモジュールスコープでキャッシュを保持するため、テストごとに vi.resetModules() でモジュールを再ロードし、キャッシュ状態が前のテストから漏れ出さないようにする。
beforeEach(() => {
  vi.resetModules()
})

describe('getDashboardKpis', () => {
  it('aggregates account/tweet counts, labeled account count, and last crawl time', async () => {
    const { getDashboardKpis } = await import('./dashboard')
    const prisma = createMockPrisma([SAMPLE_ROW])

    const result = await getDashboardKpis(prisma)

    expect(result).toEqual({
      totalAccounts: 120,
      totalTweets: 4500,
      labeledAccounts: 42,
      lastCrawledAt: new Date('2026-07-27T00:00:00Z'),
    })
  })

  it('returns 0 labeled accounts when the raw query returns no row', async () => {
    const { getDashboardKpis } = await import('./dashboard')
    const prisma = createMockPrisma([])
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
    const prisma = createMockPrisma([SAMPLE_ROW])

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
    const prisma = createMockPrisma([
      {
        labeledAccounts: 0n,
        distribution: [
          {
            labelKey: 'new-label',
            labelDescription: 'Not yet evaluated by any crawl',
            trueCount: 0,
            totalAccounts: 0,
          },
        ],
      },
    ])

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

describe('statement_timeout', () => {
  it('sets statement_timeout before running the merged raw query', async () => {
    const { getLabelDistribution } = await import('./dashboard')
    const prisma = createMockPrisma([SAMPLE_ROW])

    await getLabelDistribution(prisma)

    const calls = prisma.$executeRaw.mock.calls.map((call) =>
      (call[0] as TemplateStringsArray).join(''),
    )
    expect(calls).toContain("SET LOCAL statement_timeout = '15000'")
  })
})

describe('getLatestLabelsSummary caching', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T00:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses a single query for concurrent calls (in-flight dedup)', async () => {
    const { getDashboardKpis, getLabelDistribution } = await import('./dashboard')
    const prisma = createMockPrisma([SAMPLE_ROW])

    await Promise.all([getDashboardKpis(prisma), getLabelDistribution(prisma)])

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('reuses the cached result for a second call within the TTL', async () => {
    const { getLabelDistribution } = await import('./dashboard')
    const prisma = createMockPrisma([SAMPLE_ROW])

    await getLabelDistribution(prisma)
    vi.setSystemTime(new Date('2026-08-01T00:10:00Z')) // 15分 TTL 以内
    await getLabelDistribution(prisma)

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it('re-queries after the TTL expires', async () => {
    const { getLabelDistribution } = await import('./dashboard')
    const prisma = createMockPrisma([SAMPLE_ROW])

    await getLabelDistribution(prisma)
    vi.setSystemTime(new Date('2026-08-01T00:16:00Z')) // 15分 TTL を超過
    await getLabelDistribution(prisma)

    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
  })

  it('does not cache a failed query, and retries on the next call', async () => {
    const { getLabelDistribution } = await import('./dashboard')
    const prisma = createMockPrisma([SAMPLE_ROW])
    prisma.$transaction.mockRejectedValueOnce(new Error('query_canceled'))

    await expect(getLabelDistribution(prisma)).rejects.toThrow('query_canceled')
    const result = await getLabelDistribution(prisma)

    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
    expect(result).toEqual([
      {
        labelKey: 'spam',
        labelDescription: 'Likely spam account',
        trueCount: 7,
        totalAccounts: 120,
      },
    ])
  })
})
