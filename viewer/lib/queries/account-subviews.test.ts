import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
import { encodeCursor } from '../pagination/keyset-cursor'
import {
  getAccountClassification,
  getAccountEvidence,
  getAccountHistory,
  getAccountOverview,
  getAccountRelations,
  getAccountTechnical,
} from './account-subviews'

interface MockData {
  pointer?: unknown
  account?: unknown
  summaryLatest?: unknown
  classifications?: unknown[]
  labelDefinitions?: unknown[]
  findings?: unknown[]
  blocks?: unknown[]
  blockCount?: number
  counterparts?: unknown[]
  changes?: unknown[]
  readModelState?: unknown
}

function createMockPrisma(data: MockData) {
  const blockFindMany = vi.fn().mockResolvedValue(data.blocks ?? [])
  const blockCount = vi.fn().mockResolvedValue(data.blockCount ?? (data.blocks?.length ?? 0))
  const prisma = {
    readModelPointer: { findUnique: vi.fn().mockResolvedValue(data.pointer ?? null) },
    account: {
      findUnique: vi.fn().mockResolvedValue(data.account ?? null),
      findMany: vi.fn().mockResolvedValue(data.counterparts ?? []),
    },
    accountSummaryLatest: { findUnique: vi.fn().mockResolvedValue(data.summaryLatest ?? null) },
    accountClassificationLatest: {
      findMany: vi.fn().mockResolvedValue(data.classifications ?? []),
    },
    labelDefinition: { findMany: vi.fn().mockResolvedValue(data.labelDefinitions ?? []) },
    reviewFinding: { findMany: vi.fn().mockResolvedValue(data.findings ?? []) },
    block: { findMany: blockFindMany, count: blockCount },
    accountLabelChange: { findMany: vi.fn().mockResolvedValue(data.changes ?? []) },
    readModelState: { findUnique: vi.fn().mockResolvedValue(data.readModelState ?? null) },
    detectionPolicyVersion: { findFirst: vi.fn().mockResolvedValue(null) },
  } as unknown as PrismaClient
  return { prisma, blockFindMany, blockCount }
}

const account = {
  id: 'account-1',
  screenName: 'alice',
  displayName: 'Alice',
  bio: 'A fictional profile.',
  profileImageUrl: null,
  followersCount: 10,
  followingCount: 20,
  isBlueVerified: false,
  firstSeenAt: new Date('2026-01-01T00:00:00Z'),
  lastCrawledAt: new Date('2026-01-02T00:00:00Z'),
  updatedAt: new Date('2026-01-03T00:00:00Z'),
}

describe('getAccountOverview', () => {
  it('Account が存在しなければ null を返す', async () => {
    const { prisma } = createMockPrisma({})
    expect(await getAccountOverview(prisma, 'account-1')).toBeNull()
  })

  it('AccountSummaryLatest の行があればラベル・Finding の集計を重ねる', async () => {
    const { prisma } = createMockPrisma({
      account,
      summaryLatest: {
        activeLabelKeys: ['spam'],
        activeFindingCount: 2,
        highestFindingSeverity: 'high',
        lastClassificationChangedAt: new Date('2026-01-04T00:00:00Z'),
      },
    })

    const result = await getAccountOverview(prisma, 'account-1')

    expect(result).toMatchObject({
      accountId: 'account-1',
      screenName: 'alice',
      activeLabelKeys: ['spam'],
      activeFindingCount: 2,
      highestFindingSeverity: 'high',
    })
  })

  it('AccountSummaryLatest に行が無ければ集計値は既定値になる', async () => {
    const { prisma } = createMockPrisma({ account })

    const result = await getAccountOverview(prisma, 'account-1')

    expect(result).toMatchObject({
      activeLabelKeys: [],
      activeFindingCount: 0,
      highestFindingSeverity: null,
      lastClassificationChangedAt: null,
    })
  })

  it('ReadModelPointer(account_summary) を参照しない', async () => {
    const { prisma } = createMockPrisma({ account, summaryLatest: { activeLabelKeys: [] } })

    await getAccountOverview(prisma, 'account-1')

    expect(prisma.readModelPointer.findUnique).not.toHaveBeenCalled()
  })
})

describe('getAccountClassification', () => {
  it('AccountClassificationLatest に行が無ければ空配列を返す', async () => {
    const { prisma } = createMockPrisma({})
    expect(await getAccountClassification(prisma, 'account-1')).toEqual([])
  })

  it('labelDefinitionId を LabelDefinition.key へ解決し、observedAt を lastChangedAt として返す', async () => {
    const observedAt = new Date('2026-01-01T00:00:00Z')
    const { prisma } = createMockPrisma({
      classifications: [
        {
          labelDefinitionId: 'label-1',
          value: true,
          confidence: 0.9,
          reason: 'matched',
          observedAt,
        },
      ],
      labelDefinitions: [{ id: 'label-1', key: 'spam' }],
    })

    const result = await getAccountClassification(prisma, 'account-1')

    expect(result[0]).toMatchObject({ labelKey: 'spam', lastChangedAt: observedAt })
  })

  it('対応する LabelDefinition が無ければ labelDefinitionId をそのまま返す', async () => {
    const { prisma } = createMockPrisma({
      classifications: [
        {
          labelDefinitionId: 'label-missing',
          value: false,
          confidence: 0.1,
          reason: 'no match',
          observedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      labelDefinitions: [],
    })

    const result = await getAccountClassification(prisma, 'account-1')

    expect(result[0].labelKey).toBe('label-missing')
  })

  it('ReadModelPointer(account_summary) を参照しない', async () => {
    const { prisma } = createMockPrisma({ classifications: [] })

    await getAccountClassification(prisma, 'account-1')

    expect(prisma.readModelPointer.findUnique).not.toHaveBeenCalled()
  })
})

describe('getAccountEvidence', () => {
  it('Finding を id・type・severity・status へ整形して返す', async () => {
    const { prisma } = createMockPrisma({
      findings: [
        { id: 'finding-1', type: 'label_count_drop', currentSeverity: 'high', status: 'active' },
      ],
    })

    expect(await getAccountEvidence(prisma, 'account-1')).toEqual([
      {
        findingId: 'finding-1',
        type: 'label_count_drop',
        currentSeverity: 'high',
        status: 'active',
      },
    ])
  })
})

describe('getAccountRelations', () => {
  it('自分が blocker 側か blocked 側かで direction と相手を切り替える', async () => {
    const { prisma } = createMockPrisma({
      blocks: [
        {
          id: 'block-1',
          blockerId: 'account-1',
          blockedId: 'account-2',
          status: 'active',
          firstSeenAt: new Date('2026-01-02T00:00:00Z'),
        },
        {
          id: 'block-2',
          blockerId: 'account-3',
          blockedId: 'account-1',
          status: 'missing',
          firstSeenAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      counterparts: [
        { id: 'account-2', screenName: 'bob' },
        { id: 'account-3', screenName: 'carol' },
      ],
    })

    const result = await getAccountRelations(prisma, 'account-1')

    expect(result.items).toEqual([
      {
        blockId: 'block-1',
        direction: 'blocker',
        counterpartAccountId: 'account-2',
        counterpartScreenName: 'bob',
        status: 'active',
      },
      {
        blockId: 'block-2',
        direction: 'blocked',
        counterpartAccountId: 'account-3',
        counterpartScreenName: 'carol',
        status: 'missing',
      },
    ])
  })

  it('counterpart の screenName を解決する', async () => {
    const { prisma } = createMockPrisma({
      blocks: [
        {
          id: 'block-1',
          blockerId: 'account-1',
          blockedId: 'account-2',
          status: 'active',
          firstSeenAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      counterparts: [{ id: 'account-2', screenName: 'bob' }],
    })

    const result = await getAccountRelations(prisma, 'account-1')

    expect(result.items[0].counterpartScreenName).toBe('bob')
  })

  it('対応する Account が無ければ counterpartAccountId をそのまま使う', async () => {
    const { prisma } = createMockPrisma({
      blocks: [
        {
          id: 'block-1',
          blockerId: 'account-1',
          blockedId: 'account-2',
          status: 'active',
          firstSeenAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      counterparts: [],
    })

    const result = await getAccountRelations(prisma, 'account-1')

    expect(result.items[0].counterpartScreenName).toBe('account-2')
  })

  it('既定の limit は 25 件で、51 件のうち先頭ページを返し nextCursor を設定する', async () => {
    const blocks = Array.from({ length: 26 }, (_, i) => ({
      id: `block-${i}`,
      blockerId: 'account-1',
      blockedId: `account-x${i}`,
      status: 'active',
      firstSeenAt: new Date(2026, 0, 26 - i),
    }))
    const { prisma, blockFindMany } = createMockPrisma({ blocks, blockCount: 51 })

    const result = await getAccountRelations(prisma, 'account-1')

    expect(blockFindMany.mock.calls[0][0]).toMatchObject({ take: 26 })
    expect(result.items).toHaveLength(25)
    expect(result.nextCursor).not.toBeNull()
    expect(result.totalCount).toBe(51)
  })

  it('cursor を渡すと firstSeenAt/id より後ろの行を対象にする', async () => {
    const { prisma, blockFindMany } = createMockPrisma({ blocks: [], blockCount: 0 })
    const cursor = encodeCursor({
      sortValues: ['2026-01-01T00:00:00.000Z', 'block-25'],
      filterHash: JSON.stringify({ accountId: 'account-1' }),
    })

    await getAccountRelations(prisma, 'account-1', { cursor })

    const call = blockFindMany.mock.calls[0][0] as { where: { AND: unknown[] } }
    expect(call.where.AND).toHaveLength(2)
  })

  it('limit を指定すればその件数まで取得する', async () => {
    const { prisma, blockFindMany } = createMockPrisma({ blocks: [], blockCount: 0 })

    await getAccountRelations(prisma, 'account-1', { limit: 10 })

    expect(blockFindMany.mock.calls[0][0]).toMatchObject({ take: 11 })
  })
})

describe('getAccountHistory', () => {
  it('labelDefinitionId を labelKey に解決する', async () => {
    const changedAt = new Date('2026-01-05T00:00:00Z')
    const { prisma } = createMockPrisma({
      changes: [
        {
          id: 'change-1',
          labelDefinitionId: 'label-1',
          changeType: 'updated',
          previousValue: false,
          newValue: true,
          changedAt,
        },
      ],
      labelDefinitions: [{ id: 'label-1', key: 'spam' }],
    })

    expect(await getAccountHistory(prisma, 'account-1')).toEqual([
      {
        id: 'change-1',
        labelKey: 'spam',
        changeType: 'updated',
        previousValue: false,
        newValue: true,
        changedAt,
      },
    ])
  })

  it('対象 LabelDefinition が削除済みなら labelDefinitionId をそのまま使う', async () => {
    const changedAt = new Date('2026-01-05T00:00:00Z')
    const { prisma } = createMockPrisma({
      changes: [
        {
          id: 'change-1',
          labelDefinitionId: 'label-deleted',
          changeType: 'updated',
          previousValue: false,
          newValue: true,
          changedAt,
        },
      ],
      labelDefinitions: [],
    })

    const result = await getAccountHistory(prisma, 'account-1')

    expect(result[0].labelKey).toBe('label-deleted')
  })
})

describe('getAccountTechnical', () => {
  it('Account が存在しなければ null を返す', async () => {
    const { prisma } = createMockPrisma({})
    expect(await getAccountTechnical(prisma, 'account-1')).toBeNull()
  })

  it('account_summary_latest の freshness/watermark を併せて返す', async () => {
    // reconcileFreshness は lastSuccessAt からの経過時間でも degrade させるため、
    // 「healthy かつ degrade されない」ことを確認するには直近の時刻を使う必要がある。
    const sourceWatermarkAt = new Date('2026-01-04T00:00:00Z')
    const { prisma } = createMockPrisma({
      account,
      readModelState: {
        status: 'healthy',
        lastSuccessAt: new Date(),
        sourceWatermarkAt,
        currentGenerationId: null,
        policyHash: null,
      },
    })

    const result = await getAccountTechnical(prisma, 'account-1')

    expect(result).toMatchObject({
      accountId: 'account-1',
      freshnessStatus: 'healthy',
      sourceWatermarkAt,
    })
  })

  it('account_summary_latest が未記録なら freshnessStatus は unknown になる', async () => {
    const { prisma } = createMockPrisma({ account })

    const result = await getAccountTechnical(prisma, 'account-1')

    expect(result).toMatchObject({ freshnessStatus: 'unknown', sourceWatermarkAt: null })
  })
})
