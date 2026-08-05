import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getLatestCrawlSummary } from './latest-crawl-summary'

describe('getLatestCrawlSummary', () => {
  it('returns null when no CrawlRun exists', async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const prisma = { crawlRun: { findFirst } } as unknown as PrismaClient

    expect(await getLatestCrawlSummary(prisma)).toBeNull()
  })

  it('counts each username only once, using its latest attempt status', async () => {
    const findFirst = vi.fn().mockResolvedValue({
      id: 'run1',
      startedAt: new Date('2026-08-04T00:00:00Z'),
      finishedAt: new Date('2026-08-04T01:00:00Z'),
      status: 'success',
    })
    const queryRaw = vi.fn().mockResolvedValue([
      { username: 'alice', status: 'success' },
      { username: 'bob', status: 'partial' },
    ])
    const prisma = {
      crawlRun: { findFirst },
      $queryRaw: queryRaw,
    } as unknown as PrismaClient

    const summary = await getLatestCrawlSummary(prisma)

    expect(summary).toEqual({
      crawlRunId: 'run1',
      startedAt: new Date('2026-08-04T00:00:00Z'),
      finishedAt: new Date('2026-08-04T01:00:00Z'),
      status: 'success',
      accountCount: 2,
      successCount: 1,
      partialOrFailedCount: 1,
    })
  })
})
