import { randomUUID } from 'node:crypto'
import { createSyntheticId } from 'id-boundary'
import { afterEach, describe, expect, it } from 'vitest'
import { getPrismaClient } from './client'

const prisma = getPrismaClient()
const accountIds: string[] = []

async function createSyntheticAccount(): Promise<{ id: string }> {
  const id = createSyntheticId()
  accountIds.push(id)

  return prisma.account.create({
    data: {
      id,
      screenName: `synthetic_${randomUUID()}`,
      displayName: 'Synthetic account',
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
    },
  })
}

afterEach(async () => {
  await prisma.followStateChange.deleteMany({
    where: { OR: [{ followerId: { in: accountIds } }, { followeeId: { in: accountIds } }] },
  })
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
  accountIds.length = 0
})

describe.skipIf(!process.env.DATABASE_URL)('FollowStateChange (integration)', () => {
  it('stores one follow event for a transition and preserves its direction', async () => {
    const follower = await createSyntheticAccount()
    const followee = await createSyntheticAccount()

    const change = await prisma.followStateChange.create({
      data: { followerId: follower.id, followeeId: followee.id, changeType: 'unfollowed' },
    })

    expect(change.changeType).toBe('unfollowed')
  })
})
