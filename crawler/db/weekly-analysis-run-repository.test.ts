import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import {
  completeWeeklyAnalysisRun,
  createWeeklyAnalysisRun,
  failWeeklyAnalysisRun,
  getWeeklyAnalysisRun,
  isWeeklyAnalysisRunStatus,
  listRunningWeeklyAnalysisRuns,
  recordWeeklyAnalysisRunPullRequest,
  timeoutWeeklyAnalysisRun,
  touchWeeklyAnalysisRunHeartbeat,
} from './weekly-analysis-run-repository'

function toRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run1',
    startedAt: new Date('2026-08-05T00:00:00Z'),
    lastHeartbeatAt: new Date('2026-08-05T00:00:00Z'),
    finishedAt: null,
    staleAfterAt: new Date('2026-08-05T02:00:00Z'),
    status: 'running',
    currentPhase: null,
    errorMessage: null,
    pullRequestNumber: null,
    pullRequestUrl: null,
    sampledAccountIds: [],
    findings: null,
    commitSha: null,
    ...overrides,
  }
}

function toRecordLike(overrides: Record<string, unknown> = {}) {
  return toRow({ currentPhase: 'sampling', ...overrides })
}

describe('createWeeklyAnalysisRun', () => {
  it('creates a running row with lastHeartbeatAt and staleAfterAt from startedAt', async () => {
    const create = vi.fn().mockResolvedValue(toRow())
    const prisma = { weeklyAnalysisRun: { create } } as unknown as PrismaClient
    const startedAt = new Date('2026-08-05T00:00:00Z')

    const run = await createWeeklyAnalysisRun(prisma, startedAt, 7_200_000)

    expect(run.id).toBe('run1')
    expect(create).toHaveBeenCalledWith({
      data: {
        startedAt,
        lastHeartbeatAt: startedAt,
        staleAfterAt: new Date('2026-08-05T02:00:00Z'),
        status: 'running',
        sampledAccountIds: [],
      },
    })
  })
})

describe('getWeeklyAnalysisRun', () => {
  it('returns null when no row matches the id', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { weeklyAnalysisRun: { findUnique } } as unknown as PrismaClient

    const run = await getWeeklyAnalysisRun(prisma, 'missing')

    expect(run).toBeNull()
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'missing' } })
  })
})

describe('listRunningWeeklyAnalysisRuns', () => {
  it('lists running rows ordered by startedAt desc', async () => {
    const findMany = vi.fn().mockResolvedValue([toRow()])
    const prisma = { weeklyAnalysisRun: { findMany } } as unknown as PrismaClient

    const runs = await listRunningWeeklyAnalysisRuns(prisma)

    expect(runs).toHaveLength(1)
    expect(findMany).toHaveBeenCalledWith({
      where: { status: 'running' },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    })
  })
})

describe('touchWeeklyAnalysisRunHeartbeat', () => {
  it('updates lastHeartbeatAt, staleAfterAt and currentPhase while status is running', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const findUnique = vi.fn().mockResolvedValue(toRow({ currentPhase: 'sampling' }))
    const prisma = {
      weeklyAnalysisRun: { updateMany, findUnique },
    } as unknown as PrismaClient
    const at = new Date('2026-08-05T01:00:00Z')

    const result = await touchWeeklyAnalysisRunHeartbeat(prisma, 'run1', at, 7_200_000, 'sampling')

    expect(result).toEqual({ ok: true, alreadyTerminal: false, run: toRecordLike() })
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'run1', status: 'running' },
      data: {
        lastHeartbeatAt: at,
        staleAfterAt: new Date('2026-08-05T03:00:00Z'),
        currentPhase: 'sampling',
      },
    })
  })

  it('reports alreadyTerminal when the row is no longer running', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 })
    const findUnique = vi.fn().mockResolvedValue(toRow({ status: 'failed' }))
    const prisma = {
      weeklyAnalysisRun: { updateMany, findUnique },
    } as unknown as PrismaClient

    const result = await touchWeeklyAnalysisRunHeartbeat(
      prisma,
      'run1',
      new Date('2026-08-05T01:00:00Z'),
      7_200_000,
      'sampling',
    )

    expect(result.ok).toBe(false)
    expect(result.alreadyTerminal).toBe(true)
  })
})

describe('completeWeeklyAnalysisRun', () => {
  it('reports alreadyTerminal when the row is no longer running', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 })
    const findUnique = vi.fn().mockResolvedValue(toRow({ status: 'success' }))
    const prisma = {
      weeklyAnalysisRun: { updateMany, findUnique },
    } as unknown as PrismaClient

    const result = await completeWeeklyAnalysisRun(
      prisma,
      'run1',
      new Date('2026-08-05T01:00:00Z'),
      {
        sampledAccountIds: [],
        findings: null,
        commitSha: null,
        pullRequestNumber: null,
        pullRequestUrl: null,
      },
    )

    expect(result.ok).toBe(false)
    expect(result.alreadyTerminal).toBe(true)
  })
})

describe('failWeeklyAnalysisRun', () => {
  it('reports alreadyTerminal when the row is no longer running', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 })
    const findUnique = vi.fn().mockResolvedValue(toRow({ status: 'timeout' }))
    const prisma = {
      weeklyAnalysisRun: { updateMany, findUnique },
    } as unknown as PrismaClient

    const result = await failWeeklyAnalysisRun(
      prisma,
      'run1',
      new Date('2026-08-05T01:00:00Z'),
      'sampling phase raised an unexpected error',
    )

    expect(result.ok).toBe(false)
    expect(result.alreadyTerminal).toBe(true)
  })
})

describe('recordWeeklyAnalysisRunPullRequest', () => {
  it('updates pullRequestNumber and pullRequestUrl while status is running', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 })
    const findUnique = vi
      .fn()
      .mockResolvedValue(
        toRow({ pullRequestNumber: 42, pullRequestUrl: 'https://example.com/pr/42' }),
      )
    const prisma = {
      weeklyAnalysisRun: { updateMany, findUnique },
    } as unknown as PrismaClient

    const result = await recordWeeklyAnalysisRunPullRequest(
      prisma,
      'run1',
      42,
      'https://example.com/pr/42',
    )

    expect(result.ok).toBe(true)
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'run1', status: 'running' },
      data: { pullRequestNumber: 42, pullRequestUrl: 'https://example.com/pr/42' },
    })
  })

  it('reports alreadyTerminal when the row is no longer running', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 })
    const findUnique = vi.fn().mockResolvedValue(toRow({ status: 'failed' }))
    const prisma = {
      weeklyAnalysisRun: { updateMany, findUnique },
    } as unknown as PrismaClient

    const result = await recordWeeklyAnalysisRunPullRequest(
      prisma,
      'run1',
      42,
      'https://example.com/pr/42',
    )

    expect(result.ok).toBe(false)
    expect(result.alreadyTerminal).toBe(true)
  })
})

describe('isWeeklyAnalysisRunStatus', () => {
  it('accepts every known status value', () => {
    expect(isWeeklyAnalysisRunStatus('running')).toBe(true)
    expect(isWeeklyAnalysisRunStatus('success')).toBe(true)
    expect(isWeeklyAnalysisRunStatus('failed')).toBe(true)
    expect(isWeeklyAnalysisRunStatus('timeout')).toBe(true)
  })

  it('rejects an unknown status value', () => {
    expect(isWeeklyAnalysisRunStatus('unknown')).toBe(false)
  })
})

describe('timeoutWeeklyAnalysisRun', () => {
  it('reports alreadyTerminal when the row is no longer running', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 })
    const findUnique = vi.fn().mockResolvedValue(toRow({ status: 'failed' }))
    const prisma = {
      weeklyAnalysisRun: { updateMany, findUnique },
    } as unknown as PrismaClient

    const result = await timeoutWeeklyAnalysisRun(
      prisma,
      'run1',
      new Date('2026-08-05T01:00:00Z'),
      'no heartbeat received before staleAfterAt',
    )

    expect(result.ok).toBe(false)
    expect(result.alreadyTerminal).toBe(true)
  })
})
