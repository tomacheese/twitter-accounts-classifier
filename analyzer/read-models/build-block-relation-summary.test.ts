import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { buildBlockRelationSummary } from './build-block-relation-summary'

const prisma = getPrismaClient()

describe('buildBlockRelationSummary', () => {
  beforeEach(async () => {
    await prisma.blockRelationCurrent.deleteMany()
    await prisma.blockStateChange.deleteMany()
    await prisma.block.deleteMany()
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
})
