import { randomUUID } from 'node:crypto'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { getPrismaClient } from '../db/client'
import {
  processAccountSummaryBootstrap,
  enqueueAccountSummaryBootstrapIfNeeded,
} from './account-summary-bootstrap'

const prisma = getPrismaClient()

/** `AccountClassificationLatest` の sampling population テスト用に最小限の Account を作る。 */
async function createAccount(id: string): Promise<void> {
  await prisma.account.create({
    data: {
      id,
      screenName: id,
      displayName: id,
      followersCount: 0,
      followingCount: 0,
      tweetCount: 0,
      accountCreatedAt: new Date(),
      crawlState: { create: { lastCrawledAt: new Date('2026-01-01T00:00:00Z') } },
    },
  })
}

/** 評価状態を持たない true の行を直接作る。権限制限のないテスト用 DB 前提。 */
async function seedActiveLabel(input: {
  accountId: string
  labelDefinitionId: number
  confidence: number
  reason: string
  ruleVersion: string
  labeledAt: Date
}): Promise<void> {
  await prisma.labelRuleVersion.upsert({
    where: {
      labelDefinitionId_versionNo: { labelDefinitionId: input.labelDefinitionId, versionNo: 1 },
    },
    create: {
      labelDefinitionId: input.labelDefinitionId,
      versionNo: 1,
      ruleVersion: input.ruleVersion,
    },
    update: {},
  })
  await prisma.accountActiveLabel.create({
    data: {
      accountId: input.accountId,
      labelDefinitionId: input.labelDefinitionId,
      ruleVersionNo: 1,
      confidence: input.confidence,
      reason: input.reason,
      method: 'rule',
      labeledAt: input.labeledAt,
    },
  })
}

async function resetDb(): Promise<void> {
  await prisma.analysisWorkItem.deleteMany()
  await prisma.analysisWorkItemDone.deleteMany()
  await prisma.readModelBootstrap.deleteMany()
  await prisma.readModelState.deleteMany()
  await prisma.accountClassificationObservation.deleteMany()
  await prisma.weeklyReviewSampleBucketCount.deleteMany()
  await prisma.accountClassificationLatest.deleteMany()
  await prisma.accountSummaryLatest.deleteMany()
  await prisma.accountActiveLabel.deleteMany()
  await prisma.accountLabelState.deleteMany()
  await prisma.labelRuleVersion.deleteMany()
  await prisma.reviewFindingOccurrence.deleteMany()
  await prisma.findingEvidence.deleteMany()
  await prisma.reviewFinding.deleteMany()
  await prisma.labelDefinition.deleteMany()
  await prisma.block.deleteMany()
  await prisma.accountCrawlState.deleteMany()
  await prisma.account.deleteMany()
}

describe('processAccountSummaryBootstrap transaction options', () => {
  it('uses the legacy transaction timeout for legacy bootstrap chunks', async () => {
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
    const workItem = { id: 'work_item', triggerType: 'account_summary_bootstrap_chunk' }

    await processAccountSummaryBootstrap(fakePrisma as never, workItem as never, { chunkSize: 10 })

    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 60_000 }),
    )
    expect(tx.readModelBootstrap.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'completed', errorSummary: null }),
      }),
    )
  })

  it('uses a longer transaction timeout for sampling bootstrap chunks', async () => {
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([{ status: 'pending', cursor: null }]),
      readModelBootstrap: { update: vi.fn().mockResolvedValue({}) },
      analysisWorkItem: { upsert: vi.fn().mockResolvedValue({}) },
    }
    const transaction = vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    )
    const fakePrisma = { $transaction: transaction }
    const workItem = {
      id: 'work_item',
      triggerType: 'account_summary_sampling_bootstrap_chunk',
    }

    await processAccountSummaryBootstrap(fakePrisma as never, workItem as never, { chunkSize: 10 })

    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 120_000 }),
    )
  })
})

describe.skipIf(!process.env.DATABASE_URL)('processAccountSummaryBootstrap', () => {
  beforeEach(resetDb)

  it('does not overwrite an existing classification whose semantics no longer match AccountActiveLabel', async () => {
    const account = await prisma.account.create({
      data: {
        id: '100283528355',
        screenName: 'frank',
        displayName: 'Frank',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        crawlState: { create: { lastCrawledAt: new Date('2026-01-01T00:00:00Z') } },
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_live_label', description: 'テスト用ラベル' },
    })
    await seedActiveLabel({
      accountId: account.id,
      labelDefinitionId: labelDefinition.id,
      confidence: 0.2,
      reason: 'old reason',
      ruleVersion: 'v1',
      labeledAt: new Date('2026-01-01T00:00:00Z'),
    })
    // live crawler が、bootstrap の baseline (labeledAt=2026-01-01) より新しい
    // labeledAt (2026-01-02) の値を先に書き込んでいる状態を再現する。
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
        evaluable: true,
        labeledAt: new Date('2026-01-02T00:00:00Z'),
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

  it('inserts new classification rows as fail-closed (evaluable=false/labeledAt=null) regardless of the evaluation state of AccountActiveLabel', async () => {
    const labeledAt = new Date('2026-01-01T00:00:00Z')
    const account = await prisma.account.create({
      data: {
        id: '100713351095',
        screenName: 'judy',
        displayName: 'Judy',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        crawlState: { create: { lastCrawledAt: labeledAt } },
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_bootstrap_evaluable_label', description: 'テスト用ラベル' },
    })
    // 評価済みの true 行があっても、legacy phase は
    // sampling phase による意味的一致検証を経ずに eligible 扱いにしない。
    await seedActiveLabel({
      accountId: account.id,
      labelDefinitionId: labelDefinition.id,
      confidence: 0.8,
      reason: 'test reason',
      ruleVersion: 'v1',
      labeledAt,
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
    expect(classification?.evaluable).toBe(false)
    expect(classification?.labeledAt).toBeNull()
    // 不変条件: bootstrap は observedAt に wall-clock now ではなく label.labeledAt を使う。
    expect(classification?.observedAt.toISOString()).toBe(labeledAt.toISOString())
  })

  it('最終 chunk 完了時に ReadModelState.account_summary_latest.schemaVersion を bump しない (sampling phase の役割)', async () => {
    // Account が 0 件でも accounts.length (0) < chunkSize となり即座に isDone になる。
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
    const readModelState = await prisma.readModelState.findUnique({
      where: { modelKey: 'account_summary_latest' },
    })
    expect(readModelState).toBeNull()
  })

  it('advances cursor/processedCount exactly once per row when two work items race on the same chunk', async () => {
    // id は bigint の昇順で並ぶため、チャンク境界を事前に予測できる。
    const baseId = 100_346_667_403n
    for (let i = 0; i < 5; i++) {
      await prisma.account.create({
        data: {
          id: String(baseId + BigInt(i)),
          screenName: `user${i}`,
          displayName: `User ${i}`,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
          crawlState: { create: { lastCrawledAt: new Date() } },
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
    // 先頭 2 件のチャンクと次の 2 件のチャンクへ
    // 直列に (どちらが先でも) 一意に振り分けられ、二重処理は起きない。
    const bootstrap = await prisma.readModelBootstrap.findUnique({
      where: { modelKey: 'account_summary' },
    })
    expect(bootstrap?.processedCount).toBe(4)
    expect(bootstrap?.cursor).toBe(String(baseId + 3n))
    expect(bootstrap?.status).toBe('running')

    const processedSummaries = await prisma.accountSummaryLatest.findMany({
      where: { accountId: { gte: String(baseId), lte: String(baseId + 4n) } },
      select: { accountId: true },
    })
    expect(processedSummaries.map((row) => row.accountId).toSorted()).toEqual([0n, 1n, 2n, 3n].map((offset) => String(baseId + offset)))
  })
})

describe.skipIf(!process.env.DATABASE_URL)(
  'processAccountSummaryBootstrap classification metadata backfill (existing population only)',
  () => {
    beforeEach(resetDb)

    it('does not insert a classification row for a pair that exists only in AccountActiveLabel', async () => {
      await createAccount('100027855373')
      const labelDefinition = await prisma.labelDefinition.create({
        data: { key: 'test_label_only', description: 'テスト用ラベル' },
      })
      await seedActiveLabel({
        accountId: '100027855373',
        labelDefinitionId: labelDefinition.id,
        confidence: 0.8,
        reason: 'test reason',
        ruleVersion: 'v1',
        labeledAt: new Date('2026-01-01T00:00:00Z'),
      })
      const workItem = await prisma.analysisWorkItem.create({
        data: {
          kind: 'account_summary_bootstrap',
          triggerType: 'account_summary_sampling_bootstrap_chunk',
          triggerId: randomUUID(),
        },
      })

      await processAccountSummaryBootstrap(prisma, workItem, { chunkSize: 10 })

      const classificationCount = await prisma.accountClassificationLatest.count({
        where: { accountId: '100027855373' },
      })
      expect(classificationCount).toBe(0)
    })

    it('leaves migration-default evaluable=false/labeledAt=null untouched when the matching AccountActiveLabel row has different semantics', async () => {
      await createAccount('100291733494')
      const labelDefinition = await prisma.labelDefinition.create({
        data: { key: 'test_mismatch', description: 'テスト用ラベル' },
      })
      // migration 直後の既定値 (evaluable=false, labeledAt=null) を再現する。
      await prisma.accountClassificationLatest.create({
        data: {
          accountId: '100291733494',
          labelDefinitionId: labelDefinition.id,
          value: true,
          confidence: 0.8,
          reason: 'old reason',
          method: 'rule',
          ruleVersion: 'v1',
          observedAt: new Date('2026-01-01T00:00:00Z'),
          evaluable: false,
          labeledAt: null,
        },
      })
      // AccountActiveLabel 側は同じ key だが confidence が異なる (semantics mismatch)。
      await seedActiveLabel({
        accountId: '100291733494',
        labelDefinitionId: labelDefinition.id,
        confidence: 0.5,
        reason: 'old reason',
        ruleVersion: 'v1',
        labeledAt: new Date('2026-01-02T00:00:00Z'),
      })
      const workItem = await prisma.analysisWorkItem.create({
        data: {
          kind: 'account_summary_bootstrap',
          triggerType: 'account_summary_sampling_bootstrap_chunk',
          triggerId: randomUUID(),
        },
      })

      await processAccountSummaryBootstrap(prisma, workItem, { chunkSize: 10 })

      const classification = await prisma.accountClassificationLatest.findUniqueOrThrow({
        where: {
          accountId_labelDefinitionId: {
            accountId: '100291733494',
            labelDefinitionId: labelDefinition.id,
          },
        },
      })
      // 不一致行は evaluable/labeledAt だけでなく value/reason/ruleVersion も変更しない。
      expect(classification.value).toBe(true)
      expect(classification.reason).toBe('old reason')
      expect(classification.ruleVersion).toBe('v1')
      expect(classification.evaluable).toBe(false)
      expect(classification.labeledAt).toBeNull()
    })

    it('sets evaluable/labeledAt when the matching AccountActiveLabel row has identical semantics', async () => {
      await createAccount('100515155459')
      const labelDefinition = await prisma.labelDefinition.create({
        data: { key: 'test_match', description: 'テスト用ラベル' },
      })
      const labeledAt = new Date('2026-01-02T00:00:00Z')
      await prisma.accountClassificationLatest.create({
        data: {
          accountId: '100515155459',
          labelDefinitionId: labelDefinition.id,
          value: true,
          confidence: 0.8,
          reason: 'same reason',
          method: 'rule',
          ruleVersion: 'v1',
          observedAt: new Date('2026-01-01T00:00:00Z'),
          evaluable: false,
          labeledAt: null,
        },
      })
      await seedActiveLabel({
        accountId: '100515155459',
        labelDefinitionId: labelDefinition.id,
        confidence: 0.8,
        reason: 'same reason',
        ruleVersion: 'v1',
        labeledAt,
      })
      const workItem = await prisma.analysisWorkItem.create({
        data: {
          kind: 'account_summary_bootstrap',
          triggerType: 'account_summary_sampling_bootstrap_chunk',
          triggerId: randomUUID(),
        },
      })

      await processAccountSummaryBootstrap(prisma, workItem, { chunkSize: 10 })

      const classification = await prisma.accountClassificationLatest.findUniqueOrThrow({
        where: {
          accountId_labelDefinitionId: {
            accountId: '100515155459',
            labelDefinitionId: labelDefinition.id,
          },
        },
      })
      expect(classification.evaluable).toBe(true)
      expect(classification.labeledAt?.getTime()).toBe(labeledAt.getTime())

      // metadata-only UPDATE が WeeklyReviewSampleBucketCount trigger を発火させ、
      // eligibility 遷移 (ineligible → eligible) を反映することを確認する。
      const [{ bucket }] = await prisma.$queryRaw<{ bucket: number }[]>`
        SELECT weekly_review_sample_bucket('100515155459') AS bucket
      `
      const bucketCount = await prisma.weeklyReviewSampleBucketCount.findUnique({
        where: {
          labelDefinitionId_value_bucket: {
            labelDefinitionId: labelDefinition.id,
            value: true,
            bucket,
          },
        },
      })
      expect(bucketCount?.count).toBe(1)
    })

    it('completes immediately without scanning unrelated Account rows that have no AccountClassificationLatest row', async () => {
      // AccountClassificationLatest に行が無いアカウントを複数用意しても、
      // それらは既存 sampling population に含まれないため cursor の対象にならない。
      for (let i = 0; i < 5; i++) {
        await createAccount(String(100_406_367_032n + BigInt(i)))
      }

      const workItem = await prisma.analysisWorkItem.create({
        data: {
          kind: 'account_summary_bootstrap',
          triggerType: 'account_summary_sampling_bootstrap_chunk',
          triggerId: randomUUID(),
        },
      })

      await processAccountSummaryBootstrap(prisma, workItem, { chunkSize: 2 })

      const bootstrap = await prisma.readModelBootstrap.findUnique({
        where: { modelKey: 'account_summary_sampling_v2' },
      })
      expect(bootstrap?.status).toBe('completed')
      expect(bootstrap?.processedCount).toBe(0)
      expect(bootstrap?.cursor).toBeNull()
    })

    it('advances the sampling cursor exactly once per accountId when two work items race on the same chunk', async () => {
      const labelDefinition = await prisma.labelDefinition.create({
        data: { key: 'test_sampling_race', description: 'テスト用ラベル' },
      })
      // id は bigint の昇順で並ぶため、チャンク境界を事前に予測できる。
      const baseId = 100_743_446_399n
      for (let i = 0; i < 5; i++) {
        await createAccount(String(baseId + BigInt(i)))
        await prisma.accountClassificationLatest.create({
          data: {
            accountId: String(baseId + BigInt(i)),
            labelDefinitionId: labelDefinition.id,
            value: true,
            confidence: 0.8,
            reason: 'test reason',
            method: 'rule',
            ruleVersion: 'v1',
            observedAt: new Date('2026-01-01T00:00:00Z'),
            evaluable: false,
            labeledAt: null,
          },
        })
      }
      const workItemA = await prisma.analysisWorkItem.create({
        data: {
          kind: 'account_summary_bootstrap',
          triggerType: 'account_summary_sampling_bootstrap_chunk',
          triggerId: randomUUID(),
        },
      })
      const workItemB = await prisma.analysisWorkItem.create({
        data: {
          kind: 'account_summary_bootstrap',
          triggerType: 'account_summary_sampling_bootstrap_chunk',
          triggerId: randomUUID(),
        },
      })

      await Promise.all([
        processAccountSummaryBootstrap(prisma, workItemA, { chunkSize: 2 }),
        processAccountSummaryBootstrap(prisma, workItemB, { chunkSize: 2 }),
      ])

      // ReadModelBootstrap 行を FOR UPDATE でロックするため、2 つの WorkItem は
      // 先頭 2 件のチャンクと次の 2 件のチャンクへ
      // 直列に (どちらが先でも) 一意に振り分けられ、二重処理は起きない。
      const bootstrap = await prisma.readModelBootstrap.findUnique({
        where: { modelKey: 'account_summary_sampling_v2' },
      })
      expect(bootstrap?.processedCount).toBe(4)
      expect(bootstrap?.cursor).toBe(String(baseId + 3n))
      expect(bootstrap?.status).toBe('running')
    })
  },
)

describe.skipIf(!process.env.DATABASE_URL)('enqueueAccountSummaryBootstrapIfNeeded', () => {
  beforeEach(resetDb)

  it('enqueues only one legacy work item when called concurrently on a fresh DB', async () => {
    await Promise.all([
      enqueueAccountSummaryBootstrapIfNeeded(prisma),
      enqueueAccountSummaryBootstrapIfNeeded(prisma),
      enqueueAccountSummaryBootstrapIfNeeded(prisma),
    ])
    const workItems = await prisma.analysisWorkItem.findMany({
      where: { kind: 'account_summary_bootstrap' },
    })
    expect(workItems).toHaveLength(1)
    expect(workItems[0]?.triggerType).toBe('account_summary_bootstrap_chunk')
  })

  it('does not start the sampling phase while the legacy phase is still pending/running', async () => {
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'running', cursor: '100427814401' },
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

    const samplingRow = await prisma.readModelBootstrap.findUnique({
      where: { modelKey: 'account_summary_sampling_v2' },
    })
    expect(samplingRow).toBeNull()
    const workItems = await prisma.analysisWorkItem.findMany({
      where: { kind: 'account_summary_bootstrap' },
    })
    expect(workItems).toHaveLength(1)
  })

  it('starts the sampling phase once the legacy phase is completed (production upgrade path)', async () => {
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'completed' },
    })

    await enqueueAccountSummaryBootstrapIfNeeded(prisma)

    const samplingRow = await prisma.readModelBootstrap.findUnique({
      where: { modelKey: 'account_summary_sampling_v2' },
    })
    expect(samplingRow?.status).toBe('pending')
    const workItems = await prisma.analysisWorkItem.findMany({
      where: { kind: 'account_summary_bootstrap' },
    })
    expect(workItems).toHaveLength(1)
    expect(workItems[0]?.triggerType).toBe('account_summary_sampling_bootstrap_chunk')
  })

  it('does nothing when both phases are already completed', async () => {
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'completed' },
    })
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary_sampling_v2', status: 'completed' },
    })
    await enqueueAccountSummaryBootstrapIfNeeded(prisma)
    const workItems = await prisma.analysisWorkItem.findMany({
      where: { kind: 'account_summary_bootstrap' },
    })
    expect(workItems).toHaveLength(0)
  })

  it('self-heals an orphaned pending sampling phase with no progressable work item', async () => {
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'completed' },
    })
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary_sampling_v2', status: 'pending' },
    })
    // 進行可能な (queued/leased/failed) WorkItem が 1 件も無い状態を再現する。
    // dead まで進んだ WorkItem を残しておくことで、self-heal がそれを
    // 「進行可能」と誤判定しないことも同時に検証する。
    await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_sampling_bootstrap_chunk',
        triggerId: randomUUID(),
        status: 'dead',
      },
    })

    await enqueueAccountSummaryBootstrapIfNeeded(prisma)

    const workItems = await prisma.analysisWorkItem.findMany({
      where: { kind: 'account_summary_bootstrap', status: { not: 'dead' } },
    })
    expect(workItems).toHaveLength(1)
    expect(workItems[0]?.triggerType).toBe('account_summary_sampling_bootstrap_chunk')
  })

  it('does not double-enqueue the sampling phase when a progressable work item already exists', async () => {
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'completed' },
    })
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary_sampling_v2', status: 'running', cursor: '100427814401' },
    })
    await prisma.analysisWorkItem.create({
      data: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_sampling_bootstrap_chunk',
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

  it('starts the sampling phase under the new key even when a pre-existing buggy account_summary_v2 row is completed', async () => {
    // PR #281 のバグ入り実装が一時的に稼働した環境を模す。旧 modelKey には
    // Account-id cursor が残っている可能性があるが、新しい modelKey
    // (account_summary_sampling_v2) はこれと無関係に判定される必要がある。
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'completed' },
    })
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary_v2', status: 'completed', cursor: '100696643940' },
    })

    await enqueueAccountSummaryBootstrapIfNeeded(prisma)

    const samplingRow = await prisma.readModelBootstrap.findUnique({
      where: { modelKey: 'account_summary_sampling_v2' },
    })
    expect(samplingRow?.status).toBe('pending')
    const workItems = await prisma.analysisWorkItem.findMany({
      where: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_sampling_bootstrap_chunk',
      },
    })
    expect(workItems).toHaveLength(1)
  })

  it('starts the sampling phase under the new key even when a pre-existing buggy account_summary_v2 row is still running', async () => {
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary', status: 'completed' },
    })
    await prisma.readModelBootstrap.create({
      data: { modelKey: 'account_summary_v2', status: 'running', cursor: '100696643940' },
    })

    await enqueueAccountSummaryBootstrapIfNeeded(prisma)

    const samplingRow = await prisma.readModelBootstrap.findUnique({
      where: { modelKey: 'account_summary_sampling_v2' },
    })
    expect(samplingRow?.status).toBe('pending')
    const workItems = await prisma.analysisWorkItem.findMany({
      where: {
        kind: 'account_summary_bootstrap',
        triggerType: 'account_summary_sampling_bootstrap_chunk',
      },
    })
    expect(workItems).toHaveLength(1)
  })
})
