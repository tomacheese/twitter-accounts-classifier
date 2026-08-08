import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildBlockRelationSummary } from './build-block-relation-summary'

const prisma = getPrismaClient()

describe.skipIf(!process.env.DATABASE_URL)('buildBlockRelationSummary', () => {
  beforeEach(async () => {
    await prisma.blockRelationCurrent.deleteMany()
    await prisma.blockStateChange.deleteMany()
    await prisma.block.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.account.deleteMany()
  })

  it('Block を screenName 正規化した BlockRelationCurrent へ変換する', async () => {
    const blockerId = `account-${randomUUID()}`
    const blockedId = `account-${randomUUID()}`
    await prisma.account.createMany({
      data: [
        {
          id: blockerId,
          screenName: 'Blocker_User',
          displayName: 'Blocker',
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
        },
        {
          id: blockedId,
          screenName: 'Blocked_User',
          displayName: 'Blocked',
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
        },
      ],
    })
    await prisma.block.create({ data: { blockerId, blockedId } })

    const generationId = `generation-${randomUUID()}`
    const result = await buildBlockRelationSummary(prisma, {
      generationId,
      sourceWatermarkAt: new Date(),
    })

    expect(result.rowCount).toBe(1)
    const rows = await prisma.blockRelationCurrent.findMany({ where: { generationId } })
    expect(rows[0]?.normalizedBlockerScreenName).toBe('blocker_user')
    expect(rows[0]?.normalizedBlockedScreenName).toBe('blocked_user')
    expect(rows[0]?.status).toBe('active')
  })

  it('ページサイズを超える件数の Block でも全件が新 generationId で作られる', async () => {
    const blockerId = `account-${randomUUID()}`
    const blockedIds = Array.from({ length: 5 }, () => `account-${randomUUID()}`)
    await prisma.account.createMany({
      data: [blockerId, ...blockedIds].map((id, index) => ({
        id,
        screenName: `user_${index}_${randomUUID().slice(0, 8)}`,
        displayName: `User ${index}`,
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      })),
    })
    await prisma.block.createMany({
      data: blockedIds.map((blockedId) => ({ blockerId, blockedId })),
    })

    const generationId = `generation-${randomUUID()}`
    const result = await buildBlockRelationSummary(prisma, {
      generationId,
      sourceWatermarkAt: new Date(),
      pageSize: 2,
    })

    expect(result.rowCount).toBe(5)
    const rows = await prisma.blockRelationCurrent.findMany({ where: { generationId } })
    expect(rows).toHaveLength(5)
  })
})
