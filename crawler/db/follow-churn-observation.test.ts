import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { loadFollowChurnObservation } from './follow-churn-observation'

describe('loadFollowChurnObservation', () => {
  it('counts cycles only within the account, followee, and requested observation window', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'after-window-1',
        followerId: 'me',
        followeeId: 'one',
        changeType: 'followed',
        observedAt: new Date('2026-08-01T00:00:00Z'),
      },
      {
        id: 'after-window-2',
        followerId: 'me',
        followeeId: 'one',
        changeType: 'unfollowed',
        observedAt: new Date('2026-08-02T00:00:00Z'),
      },
      {
        id: 'after-window-3',
        followerId: 'me',
        followeeId: 'one',
        changeType: 'followed',
        observedAt: new Date('2026-08-03T00:00:00Z'),
      },
      {
        id: 'after-window-4',
        followerId: 'me',
        followeeId: 'one',
        changeType: 'unfollowed',
        observedAt: new Date('2026-08-04T00:00:00Z'),
      },
      {
        id: 'other-followee-1',
        followerId: 'me',
        followeeId: 'two',
        changeType: 'unfollowed',
        observedAt: new Date('2026-08-05T00:00:00Z'),
      },
    ])
    const prisma = { followStateChange: { findMany } } as unknown as PrismaClient

    const observation = await loadFollowChurnObservation(
      prisma,
      'me',
      new Date('2026-08-01T00:00:00Z'),
    )

    expect(observation).toEqual({ followed: 2, unfollowed: 3, completedCycles: 2 })
    expect(findMany).toHaveBeenCalledWith({
      where: { followerId: 'me', observedAt: { gte: new Date('2026-08-01T00:00:00Z') } },
      select: { id: true, followeeId: true, changeType: true, observedAt: true },
      orderBy: [{ followeeId: 'asc' }, { observedAt: 'asc' }, { id: 'asc' }],
    })
  })
})
