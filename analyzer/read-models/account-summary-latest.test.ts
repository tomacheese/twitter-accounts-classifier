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
    await prisma.block.deleteMany()
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
    await prisma.block.deleteMany()
    await prisma.account.deleteMany()
  })

  it('rejects a semantic update whose labeledAt is older than the existing row', async () => {
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
        evaluable: true,
        labeledAt: newer,
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
        observedAt: newer,
        sourceObservationId: null,
        evaluable: false,
        labeledAt: older,
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
    expect(row?.evaluable).toBe(true)
    expect(row?.labeledAt?.toISOString()).toBe(newer.toISOString())
  })

  it('反例固定: 新しい observedAt だが古い labeledAt の live refresh の後に、より新しい labeledAt の bootstrap が来ても value/evaluable/labeledAt は同一の bootstrap 由来行に揃い、observedAt/sourceObservationId は独立して最新の観測を維持する', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_interleave',
        screenName: 'dave',
        displayName: 'Dave',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_label_interleave', description: 'テスト用ラベル' },
    })
    const t10 = new Date('2026-01-01T00:00:00Z')
    const t15 = new Date('2026-01-01T00:00:05Z')
    const t20 = new Date('2026-01-01T00:00:10Z')

    // live refresh: observation t20 の時点で labeledAt=t10 の label row を読んで書き込む。
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.9,
        reason: 'live refresh reason (t10 由来)',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: t20,
        sourceObservationId: 'observation_live',
        evaluable: true,
        labeledAt: t10,
      },
    ])
    // bootstrap: より新しい labeledAt=t15 の AccountLabelLatest 行を読んで書き込む。
    // 不変条件どおり observedAt := labeledAt を使う。
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: false,
        confidence: 0.2,
        reason: 'bootstrap reason (t15 由来)',
        method: 'rule',
        ruleVersion: 'v2',
        observedAt: t15,
        sourceObservationId: 'observation_bootstrap',
        evaluable: false,
        labeledAt: t15,
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
    // semantic 系は labeledAt=t15 (bootstrap) 側に揃う。value だけ t10 由来のまま
    // 取り残されてはならない。
    expect(row?.value).toBe(false)
    expect(row?.confidence).toBe(0.2)
    expect(row?.reason).toBe('bootstrap reason (t15 由来)')
    expect(row?.ruleVersion).toBe('v2')
    expect(row?.evaluable).toBe(false)
    expect(row?.labeledAt?.toISOString()).toBe(t15.toISOString())
    // observedAt/sourceObservationId は semantic 系の勝敗と独立に、
    // observedAt が大きい live refresh (t20) 側のまま維持される。
    expect(row?.observedAt.toISOString()).toBe(t20.toISOString())
    expect(row?.sourceObservationId).toBe('observation_live')
  })

  it('反例の逆順 commit でも同一の labeledAt 由来の semantic 行に収束する', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_interleave_reverse',
        screenName: 'erin',
        displayName: 'Erin',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_label_interleave_reverse', description: 'テスト用ラベル' },
    })
    const t10 = new Date('2026-01-01T00:00:00Z')
    const t15 = new Date('2026-01-01T00:00:05Z')
    const t20 = new Date('2026-01-01T00:00:10Z')

    // bootstrap (labeledAt=t15) が先に commit する。
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: false,
        confidence: 0.2,
        reason: 'bootstrap reason (t15 由来)',
        method: 'rule',
        ruleVersion: 'v2',
        observedAt: t15,
        sourceObservationId: 'observation_bootstrap',
        evaluable: false,
        labeledAt: t15,
      },
    ])
    // live refresh (observation t20、labeledAt=t10) が後に commit する。
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.9,
        reason: 'live refresh reason (t10 由来)',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: t20,
        sourceObservationId: 'observation_live',
        evaluable: true,
        labeledAt: t10,
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
    // commit 順序を逆にしても、semantic 系は labeledAt=t15 (bootstrap) 側に収束する。
    expect(row?.value).toBe(false)
    expect(row?.evaluable).toBe(false)
    expect(row?.labeledAt?.toISOString()).toBe(t15.toISOString())
    // observedAt/sourceObservationId は独立して observedAt=t20 (live refresh) のまま。
    expect(row?.observedAt.toISOString()).toBe(t20.toISOString())
    expect(row?.sourceObservationId).toBe('observation_live')
  })

  it('1回の呼び出しでlabeledAtがnullの行とnon-nullの行が混在してもtext[]::timestamp[]経由のcastが両方を正しく書き込む', async () => {
    const accountWithLabel = await prisma.account.create({
      data: {
        id: 'acct_mixed_labeled',
        screenName: 'frank',
        displayName: 'Frank',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const accountWithoutLabel = await prisma.account.create({
      data: {
        id: 'acct_mixed_unlabeled',
        screenName: 'judy',
        displayName: 'Judy',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_label_mixed', description: 'テスト用ラベル' },
    })
    const labeledAt = new Date('2026-01-03T00:00:00Z')

    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: accountWithLabel.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.9,
        reason: 'labeled reason',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: labeledAt,
        sourceObservationId: null,
        evaluable: true,
        labeledAt,
      },
      {
        accountId: accountWithoutLabel.id,
        labelDefinitionId: labelDefinition.id,
        value: false,
        confidence: 0.1,
        reason: 'unlabeled reason',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: labeledAt,
        sourceObservationId: null,
        evaluable: false,
        labeledAt: null,
      },
    ])

    const rows = await prisma.accountClassificationLatest.findMany({
      where: { labelDefinitionId: labelDefinition.id },
      orderBy: { accountId: 'asc' },
    })
    const labeled = rows.find((row) => row.accountId === accountWithLabel.id)
    const unlabeled = rows.find((row) => row.accountId === accountWithoutLabel.id)
    expect(labeled?.labeledAt?.toISOString()).toBe(labeledAt.toISOString())
    expect(unlabeled?.labeledAt).toBeNull()
  })
})

describe('upsertAccountClassificationLatest row ordering', () => {
  it('sorts rows by labelDefinitionId ascending before building the UNNEST arrays', async () => {
    const executeRaw = vi.fn<(...args: unknown[]) => Promise<number>>(() => Promise.resolve(0))
    const fakePrisma = { $executeRaw: executeRaw } as unknown as PrismaClient

    await upsertAccountClassificationLatest(fakePrisma, [
      {
        accountId: 'acct_1',
        labelDefinitionId: 'label_z',
        value: true,
        confidence: 0.9,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-13T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:00:00Z'),
      },
      {
        accountId: 'acct_1',
        labelDefinitionId: 'label_a',
        value: false,
        confidence: 0.1,
        reason: 'r2',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-13T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:00:00Z'),
      },
    ])

    expect(executeRaw).toHaveBeenCalledTimes(1)
    const labelDefinitionIds = executeRaw.mock.calls[0][2]
    expect(labelDefinitionIds).toEqual(['label_a', 'label_z'])
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
