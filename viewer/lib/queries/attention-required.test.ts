import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getAttentionRequiredItems } from './attention-required'

function mockFindManySequence(...results: unknown[][]) {
  const fn = vi.fn()
  for (const result of results) {
    fn.mockResolvedValueOnce(result)
  }
  return fn
}

function createMockPrisma(overrides: {
  runningCrawlRuns?: unknown[]
  failedCrawlRuns?: unknown[]
  runningBlockRuns?: unknown[]
  failedBlockRuns?: unknown[]
  runningWeeklyAnalysisRuns?: unknown[]
  terminalWeeklyAnalysisRuns?: unknown[]
  warnedCrawlAccountRuns?: unknown[]
  failedBlockAccountRuns?: unknown[]
}) {
  return {
    crawlRun: {
      findMany: mockFindManySequence(
        overrides.runningCrawlRuns ?? [],
        overrides.failedCrawlRuns ?? [],
      ),
    },
    blockRun: {
      findMany: mockFindManySequence(
        overrides.runningBlockRuns ?? [],
        overrides.failedBlockRuns ?? [],
      ),
    },
    weeklyAnalysisRun: {
      findMany: mockFindManySequence(
        overrides.runningWeeklyAnalysisRuns ?? [],
        overrides.terminalWeeklyAnalysisRuns ?? [],
      ),
    },
    crawlAccountRun: {
      findMany: mockFindManySequence(overrides.warnedCrawlAccountRuns ?? []),
    },
    blockAccountRun: {
      findMany: mockFindManySequence(overrides.failedBlockAccountRuns ?? []),
    },
  } as unknown as PrismaClient
}

describe('getAttentionRequiredItems', () => {
  it('returns an empty list when nothing needs attention', async () => {
    const prisma = createMockPrisma({})
    const items = await getAttentionRequiredItems(prisma, new Date('2026-08-05T00:00:00Z'))
    expect(items).toEqual([])
  })

  it('includes a stale_run item for a Crawler run past its staleAfterAt', async () => {
    const prisma = createMockPrisma({
      runningCrawlRuns: [
        {
          id: 'run1',
          status: 'running',
          startedAt: new Date('2026-08-04T00:00:00Z'),
          staleAfterAt: new Date('2026-08-04T06:00:00Z'),
        },
      ],
    })
    const items = await getAttentionRequiredItems(prisma, new Date('2026-08-05T00:00:00Z'))

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'stale_run',
      service: 'crawler',
      href: '/crawl-runs/run1',
    })
  })

  it('does not include a running Crawler run whose staleAfterAt has not yet passed', async () => {
    const prisma = createMockPrisma({
      runningCrawlRuns: [
        {
          id: 'run1',
          status: 'running',
          startedAt: new Date('2026-08-04T00:00:00Z'),
          staleAfterAt: new Date('2026-08-06T00:00:00Z'),
        },
      ],
    })
    const items = await getAttentionRequiredItems(prisma, new Date('2026-08-05T00:00:00Z'))

    expect(items).toEqual([])
  })

  it('includes a failed_run item for a failed Blocker run', async () => {
    const prisma = createMockPrisma({
      failedBlockRuns: [
        {
          id: 'run1',
          startedAt: new Date('2026-08-04T00:00:00Z'),
          finishedAt: new Date('2026-08-04T01:00:00Z'),
        },
      ],
    })
    const items = await getAttentionRequiredItems(prisma, new Date('2026-08-05T00:00:00Z'))

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'failed_run',
      service: 'blocker',
      href: '/block-runs/run1',
      occurredAt: new Date('2026-08-04T01:00:00Z'),
    })
  })

  it('includes an account_warning item for a partial Crawler account run', async () => {
    const prisma = createMockPrisma({
      warnedCrawlAccountRuns: [
        {
          id: 'account-run-1',
          crawlRunId: 'run-1',
          username: 'bob',
          status: 'partial',
          startedAt: new Date('2026-08-04T00:00:00Z'),
        },
      ],
    })
    const items = await getAttentionRequiredItems(prisma, new Date('2026-08-05T00:00:00Z'))

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'account_warning',
      service: 'crawler',
      href: '/crawl-runs/run-1',
    })
  })

  it('includes a block_failure item for a failed BlockAccountRun', async () => {
    const prisma = createMockPrisma({
      failedBlockAccountRuns: [
        {
          id: 'account-run-1',
          blockRunId: 'run-1',
          username: 'alice',
          errorMessage: 'Example rate limit error.',
          startedAt: new Date('2026-08-04T00:00:00Z'),
        },
      ],
    })
    const items = await getAttentionRequiredItems(prisma, new Date('2026-08-05T00:00:00Z'))

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'block_failure',
      service: 'blocker',
      href: '/block-runs/run-1',
    })
  })

  it('sorts items by occurredAt descending across multiple sources', async () => {
    const prisma = createMockPrisma({
      failedBlockRuns: [
        {
          id: 'run-old',
          startedAt: new Date('2026-08-01T00:00:00Z'),
          finishedAt: new Date('2026-08-01T01:00:00Z'),
        },
      ],
      failedBlockAccountRuns: [
        {
          id: 'account-run-1',
          blockRunId: 'run-new',
          username: 'alice',
          errorMessage: 'Example error.',
          startedAt: new Date('2026-08-04T00:00:00Z'),
        },
      ],
    })
    const items = await getAttentionRequiredItems(prisma, new Date('2026-08-05T00:00:00Z'))

    expect(items.map((item) => item.href)).toEqual(['/block-runs/run-new', '/block-runs/run-old'])
  })
})
