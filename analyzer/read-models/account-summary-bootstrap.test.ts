import { randomUUID } from 'node:crypto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { getPrismaClient } from '../db/client'
import { processAccountSummaryRefresh } from '../worker-processors'
import {
  processAccountSummaryBootstrap,
  enqueueAccountSummaryBootstrapIfNeeded,
} from './account-summary-bootstrap'

const prisma = getPrismaClient()

async function resetDb(): Promise<void> {
  await prisma.analysisWorkItem.deleteMany()
  await prisma.readModelBootstrap.deleteMany()
  await prisma.readModelState.deleteMany()
  await prisma.accountClassificationObservation.deleteMany()
  await prisma.accountClassificationLatest.deleteMany()
  await prisma.accountSummaryLatest.deleteMany()
  await prisma.accountLabelLatest.deleteMany()
  await prisma.reviewFindingOccurrence.deleteMany()
  await prisma.findingEvidence.deleteMany()
  await prisma.reviewFinding.deleteMany()
  await prisma.accountLabel.deleteMany()
  await prisma.labelDefinition.deleteMany()
  await prisma.block.deleteMany()
  await prisma.account.deleteMany()
}

describe('processAccountSummaryBootstrap transaction options', () => {
  it('uses an explicit transaction timeout for bootstrap chunks', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ status: 'pending', cursor: null }]),
      readModelBootstrap: { update: vi.fn().mockResolvedValue({}) },
      account: { findMany: vi.fn().mockResolvedValue([]) },
      analysisWorkItem: { upsert: vi.fn().mockResolvedValue({}) },
    }
    const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    )
    const fakePrisma = { $transaction: transaction }
    const workItem = { id: 'work_item' }

    await processAccountSummaryBootstrap(fakePrisma as never, workItem as never, { chunkSize: 10 })

    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 60_000 }),
    )
  })
})

describe.skipIf(!process.env.DATABASE_URL)('processAccountSummaryBootstrap', () => {
  beforeEach(resetDb)

  it('has a covering index for the Account bootstrap scan', async () => {
    const rows = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'Account_account_summary_latest_cover_idx'
    `

    expect(rows).toHaveLength(1)
    expect(rows[0]?.indexdef).toContain('INCLUDE ("screenName", "displayName", "lastCrawledAt")')
  })

  it('builds AccountSummaryLatest from Account/AccountLabelLatest baseline and marks completed when done', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_bootstrap',
        screenName: 'erin',
        displayName: 'Erin',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date('2026-01-01T00:00:00Z'),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_bootstrap_label', description: 'テスト用ラベル' },
    })
    await prisma.accountLabelLatest.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.8,
        reason: 'test reason',
        method: 'rule',
        ruleVersion: 'v1',
        labeledAt: new Date('2026-01-01T00:00:00Z'),
      },
    })
    const workItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_bootstrap_chunk',
        triggerId: randomUUID(),
      },
    })

    await processAccountSummaryBootstrap(prisma, workItem, { chunkSize: 10 })

    const bootstrap = await prisma.readModelBootstrap.findUnique({
      where: { modelKey: 'account_summary' },
    })
    expect(bootstrap?.status).toBe('completed')
    const summary = await prisma.accountSummaryLatest.findUnique({
      where: { accountId: account.id },
    })
    expect(summary?.activeLabelKeys).toEqual(['test_bootstrap_label'])
    const readModelState = await prisma.readModelState.findUnique({
      where: { modelKey: 'account_summary_latest' },
    })
    expect(readModelState?.status).toBe('healthy')
    expect(readModelState?.sourceWatermarkAt?.getTime()).toBe(account.lastCrawledAt.getTime())
  })

  it('uses AccountClassificationObservation.observedAt as classificationObservedAt when it is newer than AccountLabelLatest.labeledAt', async () => {
    const labeledAt = new Date('2026-01-01T00:00:00Z')
    const observedAt = new Date('2026-01-02T00:00:00Z')
    const account = await prisma.account.create({
      data: {
        id: 'acct_bootstrap_observation',
        screenName: 'grace',
        displayName: 'Grace',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date('2026-01-01T00:00:00Z'),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_bootstrap_observation_label', description: 'テスト用ラベル' },
    })
    await prisma.accountLabelLatest.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.8,
        reason: 'test reason',
        method: 'rule',
        ruleVersion: 'v1',
        labeledAt,
      },
    })
    await prisma.accountClassificationObservation.create({
      data: { accountId: account.id, observedAt, labelCount: 1 },
    })
    const workItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_bootstrap_chunk',
        triggerId: randomUUID(),
      },
    })

    await processAccountSummaryBootstrap(prisma, workItem, { chunkSize: 10 })

    const summary = await prisma.accountSummaryLatest.findUnique({
      where: { accountId: account.id },
    })
    expect(summary?.classificationObservedAt?.getTime()).toBe(observedAt.getTime())
  })

  it('falls back to AccountLabelLatest.labeledAt when no AccountClassificationObservation exists (relabel-only account)', async () => {
    const labeledAt = new Date('2026-01-01T00:00:00Z')
    const account = await prisma.account.create({
      data: {
        id: 'acct_bootstrap_relabel_only',
        screenName: 'heidi',
        displayName: 'Heidi',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date('2026-01-01T00:00:00Z'),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_bootstrap_relabel_only_label', description: 'テスト用ラベル' },
    })
    await prisma.accountLabelLatest.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.8,
        reason: 'test reason',
        method: 'relabel',
        ruleVersion: 'v1',
        labeledAt,
      },
    })
    const workItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_bootstrap_chunk',
        triggerId: randomUUID(),
      },
    })

    await processAccountSummaryBootstrap(prisma, workItem, { chunkSize: 10 })

    const summary = await prisma.accountSummaryLatest.findUnique({
      where: { accountId: account.id },
    })
    expect(summary?.classificationObservedAt?.getTime()).toBe(labeledAt.getTime())
  })

  it('computes the same classificationObservedAt as processAccountSummaryRefresh for a normal crawl-produced account', async () => {
    const labeledAt = new Date('2026-01-01T00:00:00Z')
    const observedAt = new Date('2026-01-02T00:00:00Z')
    const account = await prisma.account.create({
      data: {
        id: 'acct_bootstrap_refresh_parity',
        screenName: 'ivan',
        displayName: 'Ivan',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: labeledAt,
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_bootstrap_refresh_parity_label', description: 'テスト用ラベル' },
    })
    const labelData = {
      accountId: account.id,
      labelDefinitionId: labelDefinition.id,
      value: true,
      confidence: 0.8,
      reason: 'test reason',
      method: 'rule',
      ruleVersion: 'v1',
      labeledAt,
    }
    // bootstrap は AccountLabelLatest を、processAccountSummaryRefresh は AccountLabel 履歴を
    // それぞれ読むため、両方に同じ値の行を用意する。
    await prisma.accountLabelLatest.create({ data: labelData })
    await prisma.accountLabel.create({ data: labelData })
    const observation = await prisma.accountClassificationObservation.create({
      data: { accountId: account.id, observedAt, labelCount: 1 },
    })
    const bootstrapWorkItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_bootstrap_chunk',
        triggerId: randomUUID(),
      },
    })

    await processAccountSummaryBootstrap(prisma, bootstrapWorkItem, { chunkSize: 10 })
    const bootstrapSummary = await prisma.accountSummaryLatest.findUnique({
      where: { accountId: account.id },
    })

    const refreshWorkItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_refresh',
        triggerType: 'account_classification_observation',
        triggerId: observation.id,
      },
    })
    await processAccountSummaryRefresh(prisma, refreshWorkItem)
    const refreshSummary = await prisma.accountSummaryLatest.findUnique({
      where: { accountId: account.id },
    })

    // lastClassificationChangedAt は一致を要求しない: 増分側の変化検出ロジックとは
    // 一致しないことを許容する既存差異のため。
    expect(bootstrapSummary?.classificationObservedAt?.getTime()).toBe(
      refreshSummary?.classificationObservedAt?.getTime(),
    )
    expect(bootstrapSummary?.classificationObservedAt?.getTime()).toBe(observedAt.getTime())
  })

  it('does not overwrite a live update that is newer than the bootstrap baseline', async () => {
    const account = await prisma.account.create({
      data: {
        id: 'acct_live_wins',
        screenName: 'frank',
        displayName: 'Frank',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date('2026-01-01T00:00:00Z'),
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_live_label', description: 'テスト用ラベル' },
    })
    await prisma.accountLabelLatest.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: false,
        confidence: 0.2,
        reason: 'old reason',
        method: 'rule',
        ruleVersion: 'v1',
        labeledAt: new Date('2026-01-01T00:00:00Z'),
      },
    })
    // live crawler が先に新しい値を書き込んでいる状態を再現する。
    await prisma.accountClassificationLatest.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.95,
        reason: 'new reason',
        method: 'rule',
        ruleVersion: 'v2',
        observedAt: new Date('2026-01-02T00:00:00Z'),
      },
    })
    const workItem = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_bootstrap_chunk',
        triggerId: randomUUID(),
      },
    })

    await processAccountSummaryBootstrap(prisma, workItem, { chunkSize: 10 })

    const classification = await prisma.accountClassificationLatest.findUnique({
      where: {
        accountId_labelDefinitionId: {
          accountId: account.id,
          labelDefinitionId: labelDefinition.id,
        },
      },
    })
    expect(classification?.value).toBe(true)
    expect(classification?.reason).toBe('new reason')
  })

  it('advances cursor/processedCount exactly once per row when two work items race on the same chunk', async () => {
    // id は 'acct_concurrent_0' .. '_4' の辞書順が数値順と一致するため、
    // orderBy: { id: 'asc' } のチャンク境界を事前に予測できる。
    for (let i = 0; i < 5; i++) {
      await prisma.account.create({
        data: {
          id: `acct_concurrent_${i}`,
          screenName: `user${i}`,
          displayName: `User ${i}`,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
          lastCrawledAt: new Date(),
        },
      })
    }
    const workItemA = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_bootstrap_chunk',
        triggerId: randomUUID(),
      },
    })
    const workItemB = await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_bootstrap_chunk',
        triggerId: randomUUID(),
      },
    })

    await Promise.all([
      processAccountSummaryBootstrap(prisma, workItemA, { chunkSize: 2 }),
      processAccountSummaryBootstrap(prisma, workItemB, { chunkSize: 2 }),
    ])

    // ReadModelBootstrap 行を FOR UPDATE でロックするため、2 つの WorkItem は
    // acct_concurrent_0/1 のチャンクと acct_concurrent_2/3 のチャンクへ
    // 直列に (どちらが先でも) 一意に振り分けられ、二重処理は起きない。
    const bootstrap = await prisma.readModelBootstrap.findUnique({
      where: { modelKey: 'account_summary' },
    })
    expect(bootstrap?.processedCount).toBe(4)
    expect(bootstrap?.cursor).toBe('acct_concurrent_3')
    expect(bootstrap?.status).toBe('running')

    const processedSummaries = await prisma.accountSummaryLatest.findMany({
      where: { accountId: { startsWith: 'acct_concurrent_' } },
      select: { accountId: true },
    })
    expect(processedSummaries.map((row) => row.accountId).toSorted()).toEqual([
      'acct_concurrent_0',
      'acct_concurrent_1',
      'acct_concurrent_2',
      'acct_concurrent_3',
    ])
  })
})

describe.skipIf(!process.env.DATABASE_URL)('enqueueAccountSummaryBootstrapIfNeeded', () => {
  beforeEach(resetDb)

  it('enqueues only one work item when called concurrently', async () => {
    await Promise.all([
      enqueueAccountSummaryBootstrapIfNeeded(prisma),
      enqueueAccountSummaryBootstrapIfNeeded(prisma),
      enqueueAccountSummaryBootstrapIfNeeded(prisma),
    ])
    const workItems = await prisma.analysisWorkItem.findMany({
      where: { kind: 'account_summary_bootstrap' },
    })
    expect(workItems).toHaveLength(1)
  })

  it('does nothing when ReadModelBootstrap is already completed', async () => {
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'completed' },
    })
    await enqueueAccountSummaryBootstrapIfNeeded(prisma)
    const workItems = await prisma.analysisWorkItem.findMany({
      where: { kind: 'account_summary_bootstrap' },
    })
    expect(workItems).toHaveLength(0)
  })

  it('self-heals an orphaned pending bootstrap with no progressable work item', async () => {
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'pending' },
    })
    // 進行可能な (queued/leased/failed) WorkItem が 1 件も無い状態を再現する。
    // dead まで進んだ WorkItem を残しておくことで、self-heal がそれを
    // 「進行可能」と誤判定しないことも同時に検証する。
    await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_bootstrap_chunk',
        triggerId: randomUUID(),
        status: 'dead',
      },
    })

    await enqueueAccountSummaryBootstrapIfNeeded(prisma)

    const workItems = await prisma.analysisWorkItem.findMany({
      where: { kind: 'account_summary_bootstrap', status: { not: 'dead' } },
    })
    expect(workItems).toHaveLength(1)
  })

  it('does not double-enqueue when a progressable work item already exists for a running bootstrap', async () => {
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'running', cursor: 'acct_1' },
    })
    await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_bootstrap_chunk',
        triggerId: randomUUID(),
        status: 'queued',
      },
    })

    await enqueueAccountSummaryBootstrapIfNeeded(prisma)

    const workItems = await prisma.analysisWorkItem.findMany({
      where: { kind: 'account_summary_bootstrap' },
    })
    expect(workItems).toHaveLength(1)
  })
})
