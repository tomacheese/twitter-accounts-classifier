import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getAllBlockRuns, getBlockRunDetail } from './block-runs'

function buildRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run1',
    startedAt: new Date('2026-07-28T00:00:00Z'),
    lastHeartbeatAt: new Date('2026-07-28T00:30:00Z'),
    finishedAt: new Date('2026-07-28T01:00:00Z'),
    status: 'completed',
    accountRuns: [
      {
        id: 'accountRun1',
        blockRunId: 'run1',
        username: 'alice',
        startedAt: new Date('2026-07-28T00:00:00Z'),
        finishedAt: new Date('2026-07-28T00:30:00Z'),
        status: 'completed',
        candidatesCount: 3,
        blockedCount: 2,
        failedCount: 1,
        errorMessage: null,
        actions: [
          {
            id: 'action1',
            blockAccountRunId: 'accountRun1',
            blockerId: 'accountAlice',
            blockedId: 'accountEve',
            blocked: { screenName: 'eve' },
            labelDefinitionId: 'label1',
            labelDefinition: { key: 'spam' },
            confidence: 0.9,
            result: 'failure',
            errorMessage: 'createBlock failed',
            createdAt: new Date('2026-07-28T00:10:00Z'),
          },
        ],
      },
    ],
    ...overrides,
  }
}

describe('getAllBlockRuns', () => {
  it('loads every run, most recent first, with only its account count', async () => {
    const { accountRuns, ...runWithoutAccountRuns } = buildRun()
    const findMany = vi
      .fn()
      .mockResolvedValue([
        { ...runWithoutAccountRuns, _count: { accountRuns: accountRuns.length } },
      ])
    const prisma = { blockRun: { findMany } } as unknown as PrismaClient

    const result = await getAllBlockRuns(prisma)

    expect(result).toEqual([{ ...runWithoutAccountRuns, accountRunCount: accountRuns.length }])
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { startedAt: 'desc' },
      include: { _count: { select: { accountRuns: true } } },
    })
  })
})

describe('getBlockRunDetail', () => {
  it('loads a single run with its account runs and only their failed actions', async () => {
    const findUnique = vi.fn().mockResolvedValue(buildRun())
    const prisma = { blockRun: { findUnique } } as unknown as PrismaClient

    const result = await getBlockRunDetail(prisma, 'run1')

    expect(result).toEqual({
      id: 'run1',
      startedAt: new Date('2026-07-28T00:00:00Z'),
      lastHeartbeatAt: new Date('2026-07-28T00:30:00Z'),
      finishedAt: new Date('2026-07-28T01:00:00Z'),
      status: 'completed',
      accountRuns: [
        {
          id: 'accountRun1',
          blockRunId: 'run1',
          username: 'alice',
          startedAt: new Date('2026-07-28T00:00:00Z'),
          finishedAt: new Date('2026-07-28T00:30:00Z'),
          status: 'completed',
          candidatesCount: 3,
          blockedCount: 2,
          failedCount: 1,
          errorMessage: null,
          failures: [
            {
              id: 'action1',
              blockedId: 'accountEve',
              blockedScreenName: 'eve',
              labelKey: 'spam',
              confidence: 0.9,
              errorMessage: 'createBlock failed',
            },
          ],
        },
      ],
    })
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'run1' },
      include: {
        accountRuns: {
          orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
          include: {
            actions: {
              where: { result: 'failure' },
              include: { blocked: true, labelDefinition: true },
            },
          },
        },
      },
    })
  })

  it('returns null when no run has that id', async () => {
    const findUnique = vi.fn().mockResolvedValue(null)
    const prisma = { blockRun: { findUnique } } as unknown as PrismaClient

    const result = await getBlockRunDetail(prisma, 'missing')

    expect(result).toBeNull()
  })
})
