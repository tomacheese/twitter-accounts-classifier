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
      lastCrawledAt: new Date('2026-01-01T00:00:00Z'),
    },
  })
}

async function resetDb(): Promise<void> {
  await prisma.analysisWorkItem.deleteMany()
  await prisma.readModelBootstrap.deleteMany()
  await prisma.readModelState.deleteMany()
  await prisma.accountClassificationObservation.deleteMany()
  await prisma.weeklyReviewSampleBucketCount.deleteMany()
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

  it('does not overwrite an existing classification whose semantics no longer match AccountLabelLatest', async () => {
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

  it('inserts new classification rows as fail-closed (evaluable=false/labeledAt=null) regardless of AccountLabelLatest.evaluable', async () => {
    const labeledAt = new Date('2026-01-01T00:00:00Z')
    const account = await prisma.account.create({
      data: {
        id: 'acct_bootstrap_evaluable',
        screenName: 'judy',
        displayName: 'Judy',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: labeledAt,
      },
    })
    const labelDefinition = await prisma.labelDefinition.create({
      data: { key: 'test_bootstrap_evaluable_label', description: 'テスト用ラベル' },
    })
    // AccountLabelLatest 側は evaluable=true でも、legacy phase は
    // sampling phase による意味的一致検証を経ずに eligible 扱いにしない。
    await prisma.accountLabelLatest.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelDefinition.id,
        value: true,
        confidence: 0.8,
        reason: 'test reason',
        method: 'rule',
        ruleVersion: 'v1',
        evaluable: true,
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

describe.skipIf(!process.env.DATABASE_URL)(
  'processAccountSummaryBootstrap classification metadata backfill (existing population only)',
  () => {
    beforeEach(resetDb)

    it('does not insert a classification row for a pair that exists only in AccountLabelLatest', async () => {
      await createAccount('acct_label_only')
      const labelDefinition = await prisma.labelDefinition.create({
        data: { key: 'test_label_only', description: 'テスト用ラベル' },
      })
      await prisma.accountLabelLatest.create({
        data: {
          accountId: 'acct_label_only',
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
          triggerType: 'account_summary_sampling_bootstrap_chunk',
          triggerId: randomUUID(),
        },
      })

      await processAccountSummaryBootstrap(prisma, workItem, { chunkSize: 10 })

      const classificationCount = await prisma.accountClassificationLatest.count({
        where: { accountId: 'acct_label_only' },
      })
      expect(classificationCount).toBe(0)
    })

    it('leaves migration-default evaluable=false/labeledAt=null untouched when the matching AccountLabelLatest row has different semantics', async () => {
      await createAccount('acct_mismatch')
      const labelDefinition = await prisma.labelDefinition.create({
        data: { key: 'test_mismatch', description: 'テスト用ラベル' },
      })
      // migration 直後の既定値 (evaluable=false, labeledAt=null) を再現する。
      await prisma.accountClassificationLatest.create({
        data: {
          accountId: 'acct_mismatch',
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
      // AccountLabelLatest 側は同じ key だが value が異なる (semantics mismatch)。
      await prisma.accountLabelLatest.create({
        data: {
          accountId: 'acct_mismatch',
          labelDefinitionId: labelDefinition.id,
          value: false,
          confidence: 0.8,
          reason: 'old reason',
          method: 'rule',
          ruleVersion: 'v1',
          labeledAt: new Date('2026-01-02T00:00:00Z'),
        },
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
            accountId: 'acct_mismatch',
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

    it('sets evaluable/labeledAt when the matching AccountLabelLatest row has identical semantics', async () => {
      await createAccount('acct_match')
      const labelDefinition = await prisma.labelDefinition.create({
        data: { key: 'test_match', description: 'テスト用ラベル' },
      })
      const labeledAt = new Date('2026-01-02T00:00:00Z')
      await prisma.accountClassificationLatest.create({
        data: {
          accountId: 'acct_match',
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
      await prisma.accountLabelLatest.create({
        data: {
          accountId: 'acct_match',
          labelDefinitionId: labelDefinition.id,
          value: true,
          confidence: 0.8,
          reason: 'same reason',
          method: 'rule',
          ruleVersion: 'v1',
          evaluable: true,
          labeledAt,
        },
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
            accountId: 'acct_match',
            labelDefinitionId: labelDefinition.id,
          },
        },
      })
      expect(classification.evaluable).toBe(true)
      expect(classification.labeledAt?.getTime()).toBe(labeledAt.getTime())

      // metadata-only UPDATE が WeeklyReviewSampleBucketCount trigger を発火させ、
      // eligibility 遷移 (ineligible → eligible) を反映することを確認する。
      const [{ bucket }] = await prisma.$queryRaw<{ bucket: number }[]>`
        SELECT weekly_review_sample_bucket('acct_match') AS bucket
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
        await createAccount(`acct_unclassified_${i}`)
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
        where: { modelKey: 'account_summary_v2' },
      })
      expect(bootstrap?.status).toBe('completed')
      expect(bootstrap?.processedCount).toBe(0)
      expect(bootstrap?.cursor).toBeNull()
    })

    it('advances the sampling cursor exactly once per accountId when two work items race on the same chunk', async () => {
      const labelDefinition = await prisma.labelDefinition.create({
        data: { key: 'test_sampling_race', description: 'テスト用ラベル' },
      })
      // id は 'acct_sampling_0' .. '_4' の辞書順が数値順と一致するため、
      // orderBy accountId asc のチャンク境界を事前に予測できる。
      for (let i = 0; i < 5; i++) {
        await createAccount(`acct_sampling_${i}`)
        await prisma.accountClassificationLatest.create({
          data: {
            accountId: `acct_sampling_${i}`,
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
      // acct_sampling_0/1 のチャンクと acct_sampling_2/3 のチャンクへ
      // 直列に (どちらが先でも) 一意に振り分けられ、二重処理は起きない。
      const bootstrap = await prisma.readModelBootstrap.findUnique({
        where: { modelKey: 'account_summary_v2' },
      })
      expect(bootstrap?.processedCount).toBe(4)
      expect(bootstrap?.cursor).toBe('acct_sampling_3')
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

    const samplingRow = await prisma.readModelBootstrap.findUnique({
      where: { modelKey: 'account_summary_v2' },
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
      where: { modelKey: 'account_summary_v2' },
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
      data: { modelKey: 'account_summary_v2', status: 'completed' },
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
      data: { modelKey: 'account_summary_v2', status: 'pending' },
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
      data: { modelKey: 'account_summary_v2', status: 'running', cursor: 'acct_1' },
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
})
