import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getNavBadgeCounts, searchAcrossEntities } from './global-search'

function createMockPrisma(overrides: { pointer?: unknown; summaryRows?: unknown[] } = {}) {
  const tweetFindMany = vi.fn()
  const accountSummaryFindMany = vi.fn().mockResolvedValue(overrides.summaryRows ?? [])
  return {
    prisma: {
      account: { findMany: vi.fn().mockResolvedValue([]) },
      readModelPointer: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            overrides.pointer === undefined
              ? { currentGenerationId: 'generation-1' }
              : overrides.pointer,
          ),
      },
      accountSummaryCurrent: { findMany: accountSummaryFindMany },
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
    accountSummaryFindMany,
  }
}

describe('searchAcrossEntities', () => {
  it('Tweet 本文は検索対象に含まれない (Tweet テーブルを一切参照しない)', async () => {
    const { prisma, tweetFindMany } = createMockPrisma()
    await searchAcrossEntities(prisma, { query: 'example' })
    expect(tweetFindMany).not.toHaveBeenCalled()
  })

  it('アカウント検索は Account 本体ではなく read model を参照する', async () => {
    const { prisma, accountSummaryFindMany } = createMockPrisma()
    await searchAcrossEntities(prisma, { query: 'example' })

    const accountFindMany = (
      prisma as unknown as { account: { findMany: ReturnType<typeof vi.fn> } }
    ).account.findMany
    expect(accountFindMany).not.toHaveBeenCalled()

    const call = accountSummaryFindMany.mock.calls[0][0] as {
      where: { generationId: string; OR: Record<string, unknown>[] }
    }
    expect(call.where.generationId).toBe('generation-1')
    expect(call.where.OR.map((condition) => Object.keys(condition)[0])).toEqual([
      'normalizedDisplayName',
      'normalizedScreenName',
    ])
  })

  it('ReadModelPointer が無ければアカウント検索結果は空になる', async () => {
    const { prisma, accountSummaryFindMany } = createMockPrisma({ pointer: null })

    const result = await searchAcrossEntities(prisma, { query: 'example' })

    expect(result.accounts).toEqual([])
    expect(accountSummaryFindMany).not.toHaveBeenCalled()
  })

  it('Label の key、Finding の id/type、Operation の cycleId のみを参照する', async () => {
    const { prisma } = createMockPrisma()
    await searchAcrossEntities(prisma, { query: 'example' })

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
