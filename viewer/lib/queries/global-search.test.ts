import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { getNavBadgeCounts, searchAcrossEntities } from './global-search'

function createMockPrisma(overrides: { summaryRows?: unknown[] } = {}) {
  const tweetFindMany = vi.fn()
  const accountSummaryFindMany = vi.fn().mockResolvedValue(overrides.summaryRows ?? [])
  return {
    prisma: {
      account: { findMany: vi.fn().mockResolvedValue([]) },
      accountSummaryLatest: { findMany: accountSummaryFindMany },
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

  it('アカウント検索は Account 本体ではなく read model の indexed query 3 本へ分割する', async () => {
    const { prisma, accountSummaryFindMany } = createMockPrisma()
    await searchAcrossEntities(prisma, { query: 'Example' })

    const accountFindMany = (
      prisma as unknown as { account: { findMany: ReturnType<typeof vi.fn> } }
    ).account.findMany
    expect(accountFindMany).not.toHaveBeenCalled()
    expect(accountSummaryFindMany).toHaveBeenCalledTimes(3)

    const calls = [0, 1, 2].map(
      (index) =>
        accountSummaryFindMany.mock.calls[index]?.[0] as { where: Record<string, unknown> },
    )
    expect(calls.every(({ where }) => !('OR' in where))).toBe(true)
  })

  it('screenName は小文字化した btree range、displayName は trigram contains で検索する', async () => {
    const { prisma, accountSummaryFindMany } = createMockPrisma()
    await searchAcrossEntities(prisma, { query: 'Example' })

    const screenNameCall = accountSummaryFindMany.mock.calls[1]?.[0] as {
      where: Record<string, unknown>
    }
    const displayNameCall = accountSummaryFindMany.mock.calls[2]?.[0] as {
      where: Record<string, unknown>
    }
    expect(screenNameCall.where.normalizedScreenName).toEqual({ gte: 'example', lt: 'example￿' })
    expect(displayNameCall.where.normalizedDisplayName).toEqual({
      contains: 'Example',
      mode: 'insensitive',
    })
  })

  it('accountId 完全一致で AccountSummaryLatest を検索する', async () => {
    const { prisma, accountSummaryFindMany } = createMockPrisma()
    accountSummaryFindMany.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
      if ('accountId' in where) {
        return Promise.resolve([
          {
            accountId: 'account-1',
            normalizedScreenName: 'alice',
            normalizedDisplayName: 'alice display',
          },
        ])
      }
      return Promise.resolve([])
    })

    const result = await searchAcrossEntities(prisma, { query: 'account-1' })

    expect(result.accounts).toEqual([
      { id: 'account-1', screenName: 'alice', displayName: 'alice display' },
    ])
    const firstCall = accountSummaryFindMany.mock.calls[0][0] as {
      where: Record<string, unknown>
    }
    expect(firstCall.where).toEqual({ accountId: 'account-1' })
  })

  it('複数の indexed query で同じ account が見つかっても重複を返さない', async () => {
    const { prisma, accountSummaryFindMany } = createMockPrisma()
    const row = {
      accountId: 'account-1',
      normalizedScreenName: 'example',
      normalizedDisplayName: 'Example',
    }
    accountSummaryFindMany
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([row])
      .mockResolvedValueOnce([row])

    const result = await searchAcrossEntities(prisma, { query: 'example' })

    expect(result.accounts).toEqual([
      { id: 'account-1', screenName: 'example', displayName: 'Example' },
    ])
  })

  it('Label の key/description、Finding の id/type/primaryScopeId、Operation の cycleId/sourceId のみを参照する', async () => {
    const { prisma } = createMockPrisma()
    await searchAcrossEntities(prisma, { query: 'example' })

    const labelFindMany = (
      prisma as unknown as { labelDefinition: { findMany: ReturnType<typeof vi.fn> } }
    ).labelDefinition.findMany
    const labelCall = labelFindMany.mock.calls[0][0] as {
      where: { OR: Record<string, unknown>[] }
    }
    expect(labelCall.where.OR.map((condition) => Object.keys(condition)[0])).toEqual([
      'key',
      'description',
    ])

    const findingFindMany = (
      prisma as unknown as { reviewFinding: { findMany: ReturnType<typeof vi.fn> } }
    ).reviewFinding.findMany
    const findingCall = findingFindMany.mock.calls[0][0] as {
      where: { OR: Record<string, unknown>[] }
    }
    expect(findingCall.where.OR.map((condition) => Object.keys(condition)[0])).toEqual([
      'id',
      'type',
      'primaryScopeId',
    ])

    const operationFindMany = (
      prisma as unknown as { operationCycle: { findMany: ReturnType<typeof vi.fn> } }
    ).operationCycle.findMany
    const operationCall = operationFindMany.mock.calls[0][0] as {
      where: { OR: Record<string, unknown>[] }
    }
    expect(operationCall.where.OR.map((condition) => Object.keys(condition)[0])).toEqual([
      'id',
      'sourceId',
    ])
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

  it('enabledEntityTypes で無効にした type は DB を問い合わせず空配列になる', async () => {
    const { prisma, accountSummaryFindMany } = createMockPrisma()

    const result = await searchAcrossEntities(prisma, {
      query: 'example',
      enabledEntityTypes: { accounts: false, labels: false },
    })

    expect(result.accounts).toEqual([])
    expect(result.labels).toEqual([])
    expect(accountSummaryFindMany).not.toHaveBeenCalled()
    const labelFindMany = (
      prisma as unknown as { labelDefinition: { findMany: ReturnType<typeof vi.fn> } }
    ).labelDefinition.findMany
    expect(labelFindMany).not.toHaveBeenCalled()

    const findingFindMany = (
      prisma as unknown as { reviewFinding: { findMany: ReturnType<typeof vi.fn> } }
    ).reviewFinding.findMany
    expect(findingFindMany).toHaveBeenCalled()
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
