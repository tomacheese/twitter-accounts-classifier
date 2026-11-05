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
  await prisma.replyHijackEvidence.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
  accountIds.length = 0
})

describe.skipIf(!process.env.DATABASE_URL)('ReplyHijackEvidence (integration)', () => {
  it('enforces one reply-hijack evidence row per account, target, and rule version', async () => {
    const account = await createSyntheticAccount()
    const evidence = {
      accountId: account.id,
      targetTweetId: createSyntheticId(),
      ruleVersion: 'synthetic-rule/1',
      swarmSize: 3,
      averageSimilarity: 0.98,
      spanHours: 1.5,
      replyTweetIds: [createSyntheticId(), createSyntheticId(), createSyntheticId()],
    }

    await prisma.replyHijackEvidence.create({ data: evidence })
    await expect(prisma.replyHijackEvidence.create({ data: evidence })).rejects.toMatchObject({
      code: 'P2002',
    })

    expect(await prisma.replyHijackEvidence.count()).toBe(1)
  })
})
