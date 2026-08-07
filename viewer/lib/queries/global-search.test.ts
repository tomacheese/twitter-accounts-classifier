import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getNavBadgeCounts, searchAcrossEntities } from './global-search'

function createMockPrisma() {
  const tweetFindMany = vi.fn()
  return {
    prisma: {
      account: { findMany: vi.fn().mockResolvedValue([]) },
      labelDefinition: { findMany: vi.fn().mockResolvedValue([]) },
      reviewFinding: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      operationCycle: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      tweet: { findMany: tweetFindMany },
    } as unknown as PrismaClient,
    tweetFindMany,
  }
}

describe('searchAcrossEntities', () => {
  it('Tweet 本文は検索対象に含まれない (Tweet テーブルを一切参照しない)', async () => {
    const { prisma, tweetFindMany } = createMockPrisma()
    await searchAcrossEntities(prisma, { query: 'example' })
    expect(tweetFindMany).not.toHaveBeenCalled()
  })

  it('Account の screenName/displayName、Label の key、Finding の id/type、Operation の cycleId のみを参照する', async () => {
    const { prisma } = createMockPrisma()
    await searchAcrossEntities(prisma, { query: 'example' })

    const accountFindMany = (
      prisma as unknown as { account: { findMany: ReturnType<typeof vi.fn> } }
    ).account.findMany
    const accountCall = accountFindMany.mock.calls[0][0] as {
      where: { OR: Record<string, unknown>[] }
    }
    const accountFields = accountCall.where.OR.map((condition) => Object.keys(condition)[0])
    expect(accountFields).toEqual(['screenName', 'displayName'])

    const labelFindMany = (
      prisma as unknown as { labelDefinition: { findMany: ReturnType<typeof vi.fn> } }
    ).labelDefinition.findMany
    const labelCall = labelFindMany.mock.calls[0][0] as { where: Record<string, unknown> }
    expect(Object.keys(labelCall.where)).toEqual(['key'])
  })

  it('空文字クエリは全カテゴリ空配列を返す', async () => {
    const { prisma } = createMockPrisma()
    expect(await searchAcrossEntities(prisma, { query: '  ' })).toEqual({
      accounts: [],
      labels: [],
      findings: [],
      operations: [],
    })
  })
})

describe('getNavBadgeCounts', () => {
  it('active/recurring の Finding 件数、attentionRequired な Cycle 件数を返す', async () => {
    const { prisma } = createMockPrisma()
    const reviewFindingCount = (
      prisma as unknown as { reviewFinding: { count: ReturnType<typeof vi.fn> } }
    ).reviewFinding.count
    reviewFindingCount.mockResolvedValue(3)
    const operationCycleCount = (
      prisma as unknown as { operationCycle: { count: ReturnType<typeof vi.fn> } }
    ).operationCycle.count
    operationCycleCount.mockResolvedValue(2)

    expect(await getNavBadgeCounts(prisma)).toEqual({
      qualityReviewCount: 3,
      operationsCount: 2,
    })
    const findingCall = reviewFindingCount.mock.calls[0][0] as {
      where: { status: { in: string[] } }
    }
    expect(findingCall.where.status.in).toEqual(['active', 'recurring'])
  })
})
