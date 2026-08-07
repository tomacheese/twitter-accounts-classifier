import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '../../generated/prisma'
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
  summary?: unknown
  classifications?: unknown[]
  labelDefinitions?: unknown[]
  findings?: unknown[]
  blocks?: unknown[]
  changes?: unknown[]
}

function createMockPrisma(data: MockData) {
  const blockFindMany = vi.fn().mockResolvedValue(data.blocks ?? [])
  const prisma = {
    readModelPointer: { findUnique: vi.fn().mockResolvedValue(data.pointer ?? null) },
    account: { findUnique: vi.fn().mockResolvedValue(data.account ?? null) },
    accountSummaryCurrent: { findUnique: vi.fn().mockResolvedValue(data.summary ?? null) },
    accountClassificationCurrent: {
      findMany: vi.fn().mockResolvedValue(data.classifications ?? []),
    },
    labelDefinition: { findMany: vi.fn().mockResolvedValue(data.labelDefinitions ?? []) },
    reviewFinding: { findMany: vi.fn().mockResolvedValue(data.findings ?? []) },
    block: { findMany: blockFindMany },
    accountLabelChange: { findMany: vi.fn().mockResolvedValue(data.changes ?? []) },
  } as unknown as PrismaClient
  return { prisma, blockFindMany }
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

  it('read model の行があればラベル・Finding の集計を重ねる', async () => {
    const { prisma } = createMockPrisma({
      account,
      pointer: { currentGenerationId: 'generation-1' },
      summary: {
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

  it('ReadModelPointer が無ければ集計値は既定値になる', async () => {
    const { prisma } = createMockPrisma({ account })

    const result = await getAccountOverview(prisma, 'account-1')

    expect(result).toMatchObject({
      activeLabelKeys: [],
      activeFindingCount: 0,
      highestFindingSeverity: null,
      lastClassificationChangedAt: null,
    })
  })
})

describe('getAccountClassification', () => {
  it('ReadModelPointer が無ければ空配列を返す', async () => {
    const { prisma } = createMockPrisma({})
    expect(await getAccountClassification(prisma, 'account-1')).toEqual([])
  })

  it('labelDefinitionId を LabelDefinition.key へ解決する', async () => {
    const { prisma } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      classifications: [
        {
          labelDefinitionId: 'label-1',
          value: true,
          confidence: 0.9,
          reason: 'matched',
          lastChangedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      labelDefinitions: [{ id: 'label-1', key: 'spam' }],
    })

    const result = await getAccountClassification(prisma, 'account-1')

    expect(result[0].labelKey).toBe('spam')
  })

  it('対応する LabelDefinition が無ければ labelDefinitionId をそのまま返す', async () => {
    const { prisma } = createMockPrisma({
      pointer: { currentGenerationId: 'generation-1' },
      classifications: [
        {
          labelDefinitionId: 'label-missing',
          value: false,
          confidence: 0.1,
          reason: 'no match',
          lastChangedAt: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      labelDefinitions: [],
    })

    const result = await getAccountClassification(prisma, 'account-1')

    expect(result[0].labelKey).toBe('label-missing')
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
        { id: 'block-1', blockerId: 'account-1', blockedId: 'account-2', status: 'active' },
        { id: 'block-2', blockerId: 'account-3', blockedId: 'account-1', status: 'missing' },
      ],
    })

    const result = await getAccountRelations(prisma, 'account-1')

    expect(result).toEqual([
      {
        blockId: 'block-1',
        direction: 'blocker',
        counterpartAccountId: 'account-2',
        status: 'active',
      },
      {
        blockId: 'block-2',
        direction: 'blocked',
        counterpartAccountId: 'account-3',
        status: 'missing',
      },
    ])
  })

  it('取得件数に上限を設ける', async () => {
    const { prisma, blockFindMany } = createMockPrisma({ blocks: [] })

    await getAccountRelations(prisma, 'account-1')

    const call = blockFindMany.mock.calls[0][0] as { take: number }
    expect(call.take).toBe(50)
  })
})

describe('getAccountHistory', () => {
  it('ラベル変化履歴を整形して返す', async () => {
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
    })

    expect(await getAccountHistory(prisma, 'account-1')).toEqual([
      {
        id: 'change-1',
        labelDefinitionId: 'label-1',
        changeType: 'updated',
        previousValue: false,
        newValue: true,
        changedAt,
      },
    ])
  })
})

describe('getAccountTechnical', () => {
  it('Account が存在しなければ null を返す', async () => {
    const { prisma } = createMockPrisma({})
    expect(await getAccountTechnical(prisma, 'account-1')).toBeNull()
  })

  it('現在の generationId を併せて返す', async () => {
    const { prisma } = createMockPrisma({
      account,
      pointer: { currentGenerationId: 'generation-1' },
    })

    const result = await getAccountTechnical(prisma, 'account-1')

    expect(result).toMatchObject({ accountId: 'account-1', generationId: 'generation-1' })
  })
})
