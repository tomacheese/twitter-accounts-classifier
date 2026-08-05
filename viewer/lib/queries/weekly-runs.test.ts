import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getAllWeeklyRuns } from './weekly-runs'

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

describe('getAllWeeklyRuns', () => {
  it('loads every run ordered by most recent first, with no limit', async () => {
    const findMany = vi.fn().mockResolvedValue([buildRun()])
    const prisma = { weeklyAnalysisRun: { findMany } } as unknown as PrismaClient

    const result = await getAllWeeklyRuns(prisma)

    expect(result).toHaveLength(1)
    expect(findMany).toHaveBeenCalledWith({ orderBy: { startedAt: 'desc' } })
  })
})
