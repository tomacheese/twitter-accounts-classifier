import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getDashboardKpis, getLabelDistribution } from './dashboard'

describe('getDashboardKpis', () => {
  it('aggregates account/tweet counts, labeled account count, and last crawl time', async () => {
    const count = vi.fn()
    count.mockResolvedValueOnce(120)
    const tweetCount = vi.fn().mockResolvedValue(4500)
    const transaction = vi.fn().mockResolvedValue([undefined, [{ count: 42n }]])
    const aggregate = vi
      .fn()
      .mockResolvedValue({ _max: { lastCrawledAt: new Date('2026-07-27T00:00:00Z') } })
    const prisma = {
      account: { count, aggregate },
      tweet: { count: tweetCount },
      $transaction: transaction,
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
    } as unknown as PrismaClient

    const result = await getDashboardKpis(prisma)

    expect(result).toEqual({
      totalAccounts: 120,
      totalTweets: 4500,
      labeledAccounts: 42,
      lastCrawledAt: new Date('2026-07-27T00:00:00Z'),
    })
  })

  it('returns 0 labeled accounts when the raw query returns no row', async () => {
    const prisma = {
      account: {
        count: vi.fn().mockResolvedValue(0),
        aggregate: vi.fn().mockResolvedValue({ _max: { lastCrawledAt: null } }),
      },
      tweet: { count: vi.fn().mockResolvedValue(0) },
      $transaction: vi.fn().mockResolvedValue([undefined, []]),
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
    } as unknown as PrismaClient

    const result = await getDashboardKpis(prisma)

    expect(result.labeledAccounts).toBe(0)
    expect(result.lastCrawledAt).toBeNull()
  })
})

describe('getLabelDistribution', () => {
  it('maps raw rows into typed distribution entries', async () => {
    const transaction = vi.fn().mockResolvedValue([
      undefined,
      [
        {
          labelKey: 'spam',
          labelDescription: 'Likely spam account',
          trueCount: 7n,
          totalAccounts: 120n,
        },
      ],
    ])
    const prisma = {
      $transaction: transaction,
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
    } as unknown as PrismaClient

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
    const transaction = vi.fn().mockResolvedValue([
      undefined,
      [
        {
          labelKey: 'new-label',
          labelDescription: 'Not yet evaluated by any crawl',
          trueCount: 0n,
          totalAccounts: 0n,
        },
      ],
    ])
    const prisma = {
      $transaction: transaction,
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(),
    } as unknown as PrismaClient

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
