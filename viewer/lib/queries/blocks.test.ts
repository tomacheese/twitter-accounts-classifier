import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { listBlocks } from './blocks'

describe('listBlocks', () => {
  it('lists blocks most recently seen first, with pagination applied', async () => {
    const findMany = vi.fn().mockResolvedValue([
      {
        id: 'block1',
        blockerId: 'accountAlice',
        blocker: { screenName: 'alice' },
        blockedId: 'accountEve',
        blocked: { screenName: 'eve' },
        firstSeenAt: new Date('2026-07-01T00:00:00Z'),
        lastSeenAt: new Date('2026-07-28T00:00:00Z'),
      },
    ])
    const count = vi.fn().mockResolvedValue(1)
    const prisma = { block: { findMany, count } } as unknown as PrismaClient

    const result = await listBlocks(prisma, { page: 2, pageSize: 20 })

    expect(result).toEqual({
      items: [
        {
          id: 'block1',
          blockerId: 'accountAlice',
          blockerScreenName: 'alice',
          blockedId: 'accountEve',
          blockedScreenName: 'eve',
          firstSeenAt: new Date('2026-07-01T00:00:00Z'),
          lastSeenAt: new Date('2026-07-28T00:00:00Z'),
        },
      ],
      totalCount: 1,
    })
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { lastSeenAt: 'desc' },
      skip: 20,
      take: 20,
      include: { blocker: true, blocked: true },
    })
    expect(count).toHaveBeenCalledWith()
  })
})
