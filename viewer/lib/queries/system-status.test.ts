import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getSystemStatus } from './system-status'

function createMockPrisma(overrides: {
  crawlRun?: unknown
  crawlRunLastSuccess?: unknown
  blockRun?: unknown
  blockRunLastSuccess?: unknown
  weeklyAnalysisRun?: unknown
  weeklyAnalysisRunLastSuccess?: unknown
}) {
  const crawlRunFindFirst = vi
    .fn()
    .mockResolvedValueOnce(overrides.crawlRun ?? null)
    .mockResolvedValueOnce(overrides.crawlRunLastSuccess ?? null)
  const blockRunFindFirst = vi
    .fn()
    .mockResolvedValueOnce(overrides.blockRun ?? null)
    .mockResolvedValueOnce(overrides.blockRunLastSuccess ?? null)
  const weeklyAnalysisRunFindFirst = vi
    .fn()
    .mockResolvedValueOnce(overrides.weeklyAnalysisRun ?? null)
    .mockResolvedValueOnce(overrides.weeklyAnalysisRunLastSuccess ?? null)

  return {
    crawlRun: { findFirst: crawlRunFindFirst },
    blockRun: { findFirst: blockRunFindFirst },
    weeklyAnalysisRun: { findFirst: weeklyAnalysisRunFindFirst },
  } as unknown as PrismaClient
}

describe('getSystemStatus', () => {
  it('returns not_run entries for all three services when no runs exist', async () => {
    const prisma = createMockPrisma({})
    const entries = await getSystemStatus(prisma, new Date('2026-08-05T00:00:00Z'))

    expect(entries).toHaveLength(3)
    expect(entries.map((entry) => entry.healthStatus)).toEqual(['not_run', 'not_run', 'not_run'])
    expect(entries.map((entry) => entry.service)).toEqual(['crawler', 'blocker', 'weekly_analysis'])
  })

  it('marks the crawler entry as stale when its staleAfterAt has passed', async () => {
    const prisma = createMockPrisma({
      crawlRun: {
        id: 'run1',
        status: 'running',
        startedAt: new Date('2026-08-04T00:00:00Z'),
        finishedAt: null,
        staleAfterAt: new Date('2026-08-04T06:00:00Z'),
      },
    })
    const entries = await getSystemStatus(prisma, new Date('2026-08-05T00:00:00Z'))

    const crawlerEntry = entries.find((entry) => entry.service === 'crawler')
    expect(crawlerEntry?.healthStatus).toBe('stale')
    expect(crawlerEntry?.detailHref).toBe('/crawl-runs')
  })

  it('computes lastDurationMs from the most recent successful weekly analysis run', async () => {
    const prisma = createMockPrisma({
      weeklyAnalysisRunLastSuccess: {
        startedAt: new Date('2026-08-01T00:00:00Z'),
        finishedAt: new Date('2026-08-01T01:30:00Z'),
      },
    })
    const entries = await getSystemStatus(prisma, new Date('2026-08-05T00:00:00Z'))

    const weeklyEntry = entries.find((entry) => entry.service === 'weekly_analysis')
    expect(weeklyEntry?.lastSuccessAt).toEqual(new Date('2026-08-01T01:30:00Z'))
    expect(weeklyEntry?.lastDurationMs).toBe(90 * 60 * 1000)
  })
})
