import { describe, expect, it, beforeEach, vi } from 'vitest'
import type { PrismaClient } from '../generated/prisma'
import { getPrismaClient } from '../db/client'
import {
  upsertAccountSummaryLatest,
  upsertAccountClassificationLatest,
  markAccountSummaryLatestFailed,
  touchAccountSummaryLatestState,
} from './account-summary-latest'

describe.skipIf(!process.env.DATABASE_URL)('upsertAccountSummaryLatest', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.accountClassificationLatest.deleteMany()
    await prisma.accountSummaryLatest.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.labelDefinition.deleteMany()
    await prisma.account.deleteMany()
  })

  it('does not roll back classificationObservedAt when a later profile-only update arrives', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_watermark',
        screenName: 'alice',
        displayName: 'Alice',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const classificationTime = new Date('2026-01-01T00:00:00Z')
    const profileTime = new Date('2026-01-02T00:00:00Z')

    await upsertAccountSummaryLatest(prisma, [
      {
        accountId: account.id,
        normalizedScreenName: 'alice',
        normalizedDisplayName: 'alice',
        searchDocument: 'alice alice',
        profileObservedAt: classificationTime,
        activeLabelKeys: ['test_label'],
        activeLabelCount: 1,
        lastClassificationChangedAt: classificationTime,
        classificationObservedAt: classificationTime,
        activeFindingCount: 0,
        highestFindingSeverity: null,
        findingObservedAt: null,
      },
    ])

    // profile のみ更新する呼び出し (classification は現状値をそのまま渡す)。
    await upsertAccountSummaryLatest(prisma, [
      {
        accountId: account.id,
        normalizedScreenName: 'alice_renamed',
        normalizedDisplayName: 'alice_renamed',
        searchDocument: 'alice_renamed alice_renamed',
        profileObservedAt: profileTime,
        activeLabelKeys: ['test_label'],
        activeLabelCount: 1,
        lastClassificationChangedAt: classificationTime,
        classificationObservedAt: classificationTime,
        activeFindingCount: 0,
        highestFindingSeverity: null,
        findingObservedAt: null,
      },
    ])

    const row = await prisma.accountSummaryLatest.findUnique({
      where: { accountId: account.id },
    })
    expect(row?.normalizedScreenName).toBe('alice_renamed')
    expect(row?.classificationObservedAt?.toISOString()).toBe(classificationTime.toISOString())
  })

  it('does not apply a stale classification update older than the current watermark', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_stale',
        screenName: 'bob',
        displayName: 'Bob',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const newer = new Date('2026-01-02T00:00:00Z')
    const older = new Date('2026-01-01T00:00:00Z')

    const base = {
      accountId: account.id,
      normalizedScreenName: 'bob',
      normalizedDisplayName: 'bob',
      searchDocument: 'bob bob',
      activeLabelCount: 0,
      activeFindingCount: 0,
      highestFindingSeverity: null,
      findingObservedAt: null,
    }
    await upsertAccountSummaryLatest(prisma, [
      {
        ...base,
        profileObservedAt: newer,
        activeLabelKeys: ['newer_label'],
        lastClassificationChangedAt: newer,
        classificationObservedAt: newer,
      },
    ])
    await upsertAccountSummaryLatest(prisma, [
      {
        ...base,
        profileObservedAt: older,
        activeLabelKeys: ['older_label'],
        lastClassificationChangedAt: older,
        classificationObservedAt: older,
      },
    ])

    const row = await prisma.accountSummaryLatest.findUnique({
      where: { accountId: account.id },
    })
    expect(row?.activeLabelKeys).toEqual(['newer_label'])
  })
})

describe.skipIf(!process.env.DATABASE_URL)('upsertAccountClassificationLatest', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.accountClassificationLatest.deleteMany()
    await prisma.accountSummaryLatest.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.labelDefinition.deleteMany()
    await prisma.account.deleteMany()
  })

  it('rejects a row whose observedAt is older than the existing row', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_class',
        screenName: 'carol',
        displayName: 'Carol',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_label_class', description: 'テスト用ラベル' },
    })
    const newer = new Date('2026-01-02T00:00:00Z')
    const older = new Date('2026-01-01T00:00:00Z')

    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.9,
        reason: 'newer reason',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: newer,
        sourceObservationId: null,
      },
    ])
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: false,
        confidence: 0.1,
        reason: 'older reason',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: older,
        sourceObservationId: null,
      },
    ])

    const row = await prisma.accountClassificationLatest.findUnique({
      where: {
        accountId_labelDefinitionId: {
          accountId: account.id,
          labelDefinitionId: labelDefinition.id,
        },
      },
    })
    expect(row?.value).toBe(true)
  })
})

function createMockPrisma() {
  const upsert = vi.fn().mockResolvedValue(undefined)
  const prisma = { readModelState: { upsert } } as unknown as PrismaClient
  return { prisma, upsert }
}

describe('touchAccountSummaryLatestState', () => {
  it('過去に失敗を記録していても、成功時に errorSummary/errorCode をクリアする', async () => {
    const { prisma, upsert } = createMockPrisma()

    await markAccountSummaryLatestFailed(prisma, 'boom')
    await touchAccountSummaryLatestState(prisma, new Date('2026-01-01T00:00:00Z'))

    const secondCall = upsert.mock.calls[1][0] as { update: Record<string, unknown> }
    expect(secondCall.update).toMatchObject({ errorSummary: null, errorCode: null })
  })

  it('create 分岐でも errorSummary/errorCode を明示的に null にする', async () => {
    const { prisma, upsert } = createMockPrisma()

    await touchAccountSummaryLatestState(prisma, new Date('2026-01-01T00:00:00Z'))

    const call = upsert.mock.calls[0][0] as { create: Record<string, unknown> }
    expect(call.create).toMatchObject({ errorSummary: null, errorCode: null })
  })
})
