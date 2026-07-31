import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getAllWeeklyRuns, getRecentWeeklyRuns } from './weekly-runs'

function buildRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run1',
    startedAt: new Date('2026-07-20T00:00:00Z'),
    finishedAt: new Date('2026-07-20T01:00:00Z'),
    commitSha: 'abc123',
    sampledAccountIds: ['a1', 'a2', 'a3'],
    findings: 'looks fine',
    ...overrides,
  }
}

describe('getRecentWeeklyRuns', () => {
  it('maps recent runs, deriving sampled account count from the JSON array', async () => {
    const findMany = vi.fn().mockResolvedValue([buildRun()])
    const prisma = { weeklyAnalysisRun: { findMany } } as unknown as PrismaClient

    const result = await getRecentWeeklyRuns(prisma, 5)

    expect(result).toEqual([
      {
        id: 'run1',
        startedAt: new Date('2026-07-20T00:00:00Z'),
        finishedAt: new Date('2026-07-20T01:00:00Z'),
        commitSha: 'abc123',
        sampledAccountCount: 3,
        findings: 'looks fine',
      },
    ])
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { startedAt: 'desc' },
      take: 5,
    })
  })

  it('reports 0 sampled accounts when sampledAccountIds is not an array', async () => {
    const findMany = vi.fn().mockResolvedValue([buildRun({ sampledAccountIds: null })])
    const prisma = { weeklyAnalysisRun: { findMany } } as unknown as PrismaClient

    const result = await getRecentWeeklyRuns(prisma, 5)

    expect(result[0].sampledAccountCount).toBe(0)
  })
})

describe('getAllWeeklyRuns', () => {
  it('loads every run ordered by most recent first, with no limit', async () => {
    const findMany = vi.fn().mockResolvedValue([buildRun()])
    const prisma = { weeklyAnalysisRun: { findMany } } as unknown as PrismaClient

    const result = await getAllWeeklyRuns(prisma)

    expect(result).toHaveLength(1)
    expect(findMany).toHaveBeenCalledWith({ orderBy: { startedAt: 'desc' } })
  })
})
