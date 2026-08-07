import { describe, it, expect, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPrismaClient } from '../db/client'
import { computeBlockReconciliation, reconcileBlockRelations } from './reconcile-block-relations'

describe('computeBlockReconciliation', () => {
  it('完全同期で対象が存在しない場合のみ missing count を進める', () => {
    const result = computeBlockReconciliation({
      existingStatus: 'active',
      consecutiveMissingCount: 0,
      isPresent: false,
      isCompleteSync: true,
    })
    expect(result.nextStatus).toBe('missing')
    expect(result.consecutiveMissingCount).toBe(1)
  })

  it('不完全な取得では absence を確定しない', () => {
    const result = computeBlockReconciliation({
      existingStatus: 'active',
      consecutiveMissingCount: 0,
      isPresent: false,
      isCompleteSync: false,
    })
    expect(result.nextStatus).toBe('active')
    expect(result.consecutiveMissingCount).toBe(0)
  })

  it('連続 missing 条件を満たすと resolved になる', () => {
    const result = computeBlockReconciliation({
      existingStatus: 'missing',
      consecutiveMissingCount: 2,
      isPresent: false,
      isCompleteSync: true,
      resolutionCount: 3,
    })
    expect(result.nextStatus).toBe('resolved')
  })

  it('再び observed されれば active へ戻る', () => {
    const result = computeBlockReconciliation({
      existingStatus: 'missing',
      consecutiveMissingCount: 1,
      isPresent: true,
      isCompleteSync: true,
    })
    expect(result.nextStatus).toBe('active')
    expect(result.consecutiveMissingCount).toBe(0)
  })
})

describe('reconcileBlockRelations', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.blockStateChange.deleteMany()
    await prisma.block.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.account.deleteMany()
  })

  it('完全同期で存在しない Block を missing へ進め、BlockStateChange を 1 件追加する', async () => {
    const blockerId = `account-${randomUUID()}`
    const blockedId = `account-${randomUUID()}`
    await prisma.account.createMany({
      data: [blockerId, blockedId].map((id) => ({
        id,
        screenName: id,
        displayName: id,
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      })),
    })
    await prisma.block.create({ data: { blockerId, blockedId } })

    await reconcileBlockRelations(prisma, {
      blockerId,
      fetchedBlockedIds: [],
      isCompleteSync: true,
      now: new Date(),
    })

    const block = await prisma.block.findUniqueOrThrow({
      where: { blockerId_blockedId: { blockerId, blockedId } },
    })
    expect(block.status).toBe('missing')
    expect(block.consecutiveMissingCount).toBe(1)

    const changes = await prisma.blockStateChange.findMany({ where: { blockId: block.id } })
    expect(changes).toHaveLength(1)
    expect(changes[0]?.toStatus).toBe('missing')
  })

  it('fetch 対象に含まれていれば状態変化なしとして BlockStateChange を追加しない', async () => {
    const blockerId = `account-${randomUUID()}`
    const blockedId = `account-${randomUUID()}`
    await prisma.account.createMany({
      data: [blockerId, blockedId].map((id) => ({
        id,
        screenName: id,
        displayName: id,
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      })),
    })
    await prisma.block.create({ data: { blockerId, blockedId } })

    await reconcileBlockRelations(prisma, {
      blockerId,
      fetchedBlockedIds: [blockedId],
      isCompleteSync: true,
      now: new Date(),
    })

    const changes = await prisma.blockStateChange.findMany()
    expect(changes).toHaveLength(0)
  })
})
