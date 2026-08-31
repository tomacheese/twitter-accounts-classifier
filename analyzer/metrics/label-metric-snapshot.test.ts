import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getPrismaClient } from '../db/client'
import { upsertAccountClassificationLatest } from '../read-models/account-summary-latest'
import {
  buildLabelAggregateSnapshotSet,
  compactFreshnessBucketsForAllLabelsForTest,
  compactFreshnessBucketsForTest,
  deriveCompletenessFromCoverage,
} from './label-metric-snapshot'

/**
 * AccountClassificationLatest から素朴に GROUP BY した value 別件数を返す。
 * トリガー維持テーブルとの突き合わせ用。
 * @param labelDefinitionId - 対象の labelDefinitionId
 * @returns value ごとの件数マップ
 */
async function naiveValueCounts(labelDefinitionId: string): Promise<Map<boolean, number>> {
  const prisma = getPrismaClient()
  const rows = await prisma.$queryRaw<{ value: boolean; count: bigint }[]>`
    SELECT "value", COUNT(*) AS count FROM "AccountClassificationLatest"
    WHERE "labelDefinitionId" = ${labelDefinitionId} GROUP BY 1
  `
  return new Map(rows.map((row) => [row.value, Number(row.count)]))
}

describe('deriveCompletenessFromCoverage', () => {
  it('returns unknown when coverage is below minCoverage', () => {
    expect(deriveCompletenessFromCoverage(0.3, 0, { minCoverage: 0.5, maxStaleRatio: 0.5 })).toBe(
      'unknown',
    )
  })
  it('returns partial when coverage is sufficient but staleRatio exceeds maxStaleRatio', () => {
    expect(deriveCompletenessFromCoverage(0.9, 0.6, { minCoverage: 0.5, maxStaleRatio: 0.5 })).toBe(
      'partial',
    )
  })
  it('returns complete when both coverage and staleRatio are within thresholds', () => {
    expect(deriveCompletenessFromCoverage(0.9, 0.1, { minCoverage: 0.5, maxStaleRatio: 0.5 })).toBe(
      'complete',
    )
  })
})

describe('buildLabelAggregateSnapshotSet aggregation shape', () => {
  const aggregateCountTables = [
    'AccountClassificationValueCount',
    'AccountClassificationConfidenceBucketCount',
    'AccountClassificationRuleVersionCount',
    'AccountClassificationFreshnessBucket',
    'AccountClassificationReasonCount',
  ]

  it(`reads population count from AccountSummaryLatest and aggregates from the ${aggregateCountTables.length} count tables`, async () => {
    const snapshotAt = new Date('2026-08-09T00:00:00Z')
    const queryRaw = vi.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?')
      if (sql.includes('SELECT now() AS now')) return Promise.resolve([{ now: snapshotAt }])
      if (sql.includes('FROM "AccountClassificationFreshnessBucket"') && sql.includes('WHERE'))
        return Promise.resolve([])
      if (sql.includes('FROM "AccountSummaryLatest"')) return Promise.resolve([{ count: 1n }])
      return Promise.resolve([])
    })
    const executeRaw = vi.fn<(strings: TemplateStringsArray) => Promise<number>>(() =>
      Promise.resolve(0),
    )
    const fakeTx = {
      $executeRaw: executeRaw,
      $queryRaw: queryRaw,
      labelMetricSnapshot: { upsert: vi.fn(() => Promise.resolve({})) },
    }
    const fakePrisma = {
      labelDefinition: {
        findMany: vi.fn(() => Promise.resolve([{ id: 'label-a' }, { id: 'label-b' }])),
      },
      labelMetricSnapshot: { count: vi.fn(() => Promise.resolve(0)) },
      $transaction: vi.fn((callback: (tx: typeof fakeTx) => Promise<Date>) => callback(fakeTx)),
    }

    await buildLabelAggregateSnapshotSet(fakePrisma as never, {
      triggerWorkItemId: 'work_item_single_scan',
      policyHash: 'hash',
      analyzerVersion: 'test',
      thresholds: { minCoverage: 0, maxStaleRatio: 1 },
      freshnessThresholdsMs: { delayedAfterMs: 10 * 60 * 1000, staleAfterMs: 20 * 60 * 1000 },
    })

    const queriedSql = queryRaw.mock.calls.map((call) => call[0].join('?'))
    const populationQuery = queriedSql.find((sql) => sql.includes('FROM "AccountSummaryLatest"'))
    expect(populationQuery).toContain('classificationObservedAt')

    // 集計本体が旧来の AccountClassificationLatest 直接 GROUP BY ではなく、
    // 集計テーブル群から読むことを確認する。
    for (const table of aggregateCountTables) {
      expect(queriedSql.some((sql) => sql.includes(`FROM "${table}"`))).toBe(true)
    }
    // reasonDistribution も集計テーブル読み取りに置き換わったため、
    // AccountClassificationLatest への直接参照はゼロになる。
    const classificationLatestQueries = queriedSql.filter((sql) =>
      sql.includes('FROM "AccountClassificationLatest"'),
    )
    expect(classificationLatestQueries).toHaveLength(0)
  })
})

describe('buildLabelAggregateSnapshotSet freshness threshold assertions', () => {
  const fakePrisma = {
    labelDefinition: { findMany: vi.fn(() => Promise.resolve([])) },
    labelMetricSnapshot: { count: vi.fn(() => Promise.resolve(0)) },
    $transaction: vi.fn(),
  }

  it('staleAfterMs が7日を超えると例外を投げる', async () => {
    await expect(
      buildLabelAggregateSnapshotSet(fakePrisma as never, {
        triggerWorkItemId: 'work_item_stale_too_large',
        policyHash: 'hash',
        analyzerVersion: 'test',
        thresholds: { minCoverage: 0, maxStaleRatio: 1 },
        freshnessThresholdsMs: {
          delayedAfterMs: 10 * 60 * 1000,
          staleAfterMs: 8 * 24 * 60 * 60 * 1000,
        },
      }),
    ).rejects.toThrow(/staleAfterMs/)
  })

  it('delayedAfterMs が分単位丸めの粒度未満だと例外を投げる', async () => {
    await expect(
      buildLabelAggregateSnapshotSet(fakePrisma as never, {
        triggerWorkItemId: 'work_item_delayed_too_small',
        policyHash: 'hash',
        analyzerVersion: 'test',
        thresholds: { minCoverage: 0, maxStaleRatio: 1 },
        freshnessThresholdsMs: { delayedAfterMs: 60 * 1000, staleAfterMs: 20 * 60 * 1000 },
      }),
    ).rejects.toThrow(/delayedAfterMs\/staleAfterMs/)
  })
})

describe('buildLabelAggregateSnapshotSet transaction options', () => {
  it('allows production-scale label aggregation to run longer than Prisma default timeout', async () => {
    const transaction = vi.fn(() => Promise.resolve(new Date('2026-08-09T00:00:00Z')))
    const fakePrisma = {
      labelDefinition: { findMany: vi.fn(() => Promise.resolve([])) },
      labelMetricSnapshot: { count: vi.fn(() => Promise.resolve(0)) },
      $transaction: transaction,
    }

    await buildLabelAggregateSnapshotSet(fakePrisma as never, {
      triggerWorkItemId: 'work_item_timeout',
      policyHash: 'hash',
      analyzerVersion: 'test',
      thresholds: { minCoverage: 0, maxStaleRatio: 1 },
      freshnessThresholdsMs: { delayedAfterMs: 10 * 60 * 1000, staleAfterMs: 20 * 60 * 1000 },
    })

    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'RepeatableRead', timeout: 60_000 }),
    )
  })
})

describe.skipIf(!process.env.DATABASE_URL)('buildLabelAggregateSnapshotSet', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.labelMetricSnapshot.deleteMany()
    await prisma.accountClassificationValueCount.deleteMany()
    await prisma.accountClassificationConfidenceBucketCount.deleteMany()
    await prisma.accountClassificationRuleVersionCount.deleteMany()
    await prisma.accountClassificationFreshnessBucket.deleteMany()
    await prisma.accountClassificationReasonCount.deleteMany()
    await prisma.accountClassificationLatest.deleteMany()
    await prisma.accountSummaryLatest.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.labelDefinition.deleteMany()
    await prisma.block.deleteMany()
    await prisma.account.deleteMany()
  })

  it('writes one LabelMetricSnapshot row per LabelDefinition sharing the same snapshotAt', async () => {
    const labelA = await prisma.labelDefinition.create({
      data: { key: 'test_snapshot_a', description: 'テスト用ラベルA' },
    })
    await prisma.labelDefinition.create({
      data: { key: 'test_snapshot_b', description: 'テスト用ラベルB' },
    })
    const account = await prisma.account.create({
      data: {
        id: 'acct_snapshot',
        screenName: 'grace',
        displayName: 'Grace',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date(),
      },
    })
    await prisma.accountClassificationLatest.create({
      data: {
        accountId: account.id,
        labelDefinitionId: labelA.id,
        value: true,
        confidence: 0.9,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date(),
      },
    })
    await prisma.accountSummaryLatest.create({
      data: {
        accountId: account.id,
        normalizedScreenName: account.screenName,
        normalizedDisplayName: account.displayName,
        searchDocument: account.screenName,
        profileObservedAt: new Date(),
        activeLabelKeys: [],
        activeLabelCount: 0,
        classificationObservedAt: new Date(),
      },
    })

    const result = await buildLabelAggregateSnapshotSet(prisma, {
      triggerWorkItemId: 'work_item_1',
      policyHash: 'hash',
      analyzerVersion: 'test',
      thresholds: { minCoverage: 0, maxStaleRatio: 1 },
      freshnessThresholdsMs: {
        delayedAfterMs: 3 * 60 * 60 * 1000,
        staleAfterMs: 12 * 60 * 60 * 1000,
      },
    })

    expect(result.reused).toBe(false)
    const snapshots = await prisma.labelMetricSnapshot.findMany({
      where: { triggerWorkItemId: 'work_item_1' },
    })
    expect(snapshots).toHaveLength(2)
    expect(new Set(snapshots.map((s) => s.observedAt.getTime()))).toEqual(
      new Set([result.snapshotAt.getTime()]),
    )
    expect(snapshots.every((s) => s.populationCount === 1)).toBe(true)
  })

  it('reuses the existing committed snapshot set on retry instead of rebuilding', async () => {
    await prisma.labelDefinition.create({
      data: { key: 'test_snapshot_reuse', description: 'テスト用ラベル' },
    })
    const buildInput = {
      triggerWorkItemId: 'work_item_reuse',
      policyHash: 'hash',
      analyzerVersion: 'test',
      thresholds: { minCoverage: 0, maxStaleRatio: 1 },
      freshnessThresholdsMs: {
        delayedAfterMs: 3 * 60 * 60 * 1000,
        staleAfterMs: 12 * 60 * 60 * 1000,
      },
    }
    const first = await buildLabelAggregateSnapshotSet(prisma, buildInput)
    const second = await buildLabelAggregateSnapshotSet(prisma, buildInput)
    expect(second.reused).toBe(true)
    expect(second.snapshotAt.getTime()).toBe(first.snapshotAt.getTime())
  })

  it('classifies current/delayed/stale counts via the FILTER-based SQL aggregation, not per-row JS', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_snapshot_freshness', description: 'テスト用ラベル' },
    })
    const now = new Date()
    const currentAt = new Date(now.getTime() - 60 * 60 * 1000)
    const delayedAt = new Date(now.getTime() - 6 * 60 * 60 * 1000)
    const staleAt = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    for (const [id, observedAt] of [
      ['acct_fresh_current', currentAt],
      ['acct_fresh_delayed', delayedAt],
      ['acct_fresh_stale', staleAt],
    ] as const) {
      await prisma.account.create({
        data: {
          id,
          screenName: id,
          displayName: id,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
          lastCrawledAt: new Date(),
        },
      })
      await prisma.accountClassificationLatest.create({
        data: {
          accountId: id,
          labelDefinitionId: label.id,
          value: true,
          confidence: 0.9,
          reason: 'r',
          method: 'rule',
          ruleVersion: 'v1',
          observedAt,
        },
      })
    }

    const result = await buildLabelAggregateSnapshotSet(prisma, {
      triggerWorkItemId: 'work_item_freshness',
      policyHash: 'hash',
      analyzerVersion: 'test',
      thresholds: { minCoverage: 0, maxStaleRatio: 1 },
      freshnessThresholdsMs: {
        delayedAfterMs: 3 * 60 * 60 * 1000,
        staleAfterMs: 12 * 60 * 60 * 1000,
      },
    })

    const snapshot = await prisma.labelMetricSnapshot.findFirstOrThrow({
      where: { triggerWorkItemId: 'work_item_freshness', labelDefinitionId: label.id },
    })
    expect(result.reused).toBe(false)
    expect(snapshot.currentCount).toBe(1)
    expect(snapshot.delayedCount).toBe(1)
    expect(snapshot.staleCount).toBe(1)
    expect(snapshot.evaluatedCount).toBe(3)
  })

  it('AccountSummaryLatest 基準の populationCount が AccountClassificationLatest の distinct accountId 数と一致する', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_population_equiv', description: 'テスト用ラベル' },
    })
    for (const id of ['acct_pop_1', 'acct_pop_2', 'acct_pop_3']) {
      await prisma.account.create({
        data: {
          id,
          screenName: id,
          displayName: id,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
          lastCrawledAt: new Date(),
        },
      })
      await prisma.accountClassificationLatest.create({
        data: {
          accountId: id,
          labelDefinitionId: label.id,
          value: true,
          confidence: 0.9,
          reason: 'r',
          method: 'rule',
          ruleVersion: 'v1',
          observedAt: new Date(),
        },
      })
      await prisma.accountSummaryLatest.create({
        data: {
          accountId: id,
          normalizedScreenName: id,
          normalizedDisplayName: id,
          searchDocument: id,
          profileObservedAt: new Date(),
          activeLabelKeys: [],
          activeLabelCount: 0,
          classificationObservedAt: new Date(),
        },
      })
    }
    // populationCount の定義には現れない account (AccountClassificationLatest に
    // 行がない) が母集団を膨らませないことも同時に確認する。
    await prisma.account.create({
      data: {
        id: 'acct_pop_unclassified',
        screenName: 'acct_pop_unclassified',
        displayName: 'acct_pop_unclassified',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date(),
      },
    })
    await prisma.accountSummaryLatest.create({
      data: {
        accountId: 'acct_pop_unclassified',
        normalizedScreenName: 'acct_pop_unclassified',
        normalizedDisplayName: 'acct_pop_unclassified',
        searchDocument: 'acct_pop_unclassified',
        profileObservedAt: new Date(),
        activeLabelKeys: [],
        activeLabelCount: 0,
        classificationObservedAt: null,
      },
    })

    const result = await buildLabelAggregateSnapshotSet(prisma, {
      triggerWorkItemId: 'work_item_population_equiv',
      policyHash: 'hash',
      analyzerVersion: 'test',
      thresholds: { minCoverage: 0, maxStaleRatio: 1 },
      freshnessThresholdsMs: {
        delayedAfterMs: 3 * 60 * 60 * 1000,
        staleAfterMs: 12 * 60 * 60 * 1000,
      },
    })

    expect(result.reused).toBe(false)
    const snapshot = await prisma.labelMetricSnapshot.findFirstOrThrow({
      where: { triggerWorkItemId: 'work_item_population_equiv', labelDefinitionId: label.id },
    })
    expect(snapshot.populationCount).toBe(3)
  })
})

describe.skipIf(!process.env.DATABASE_URL)('AccountClassificationLatest aggregate trigger', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.accountClassificationValueCount.deleteMany()
    await prisma.accountClassificationConfidenceBucketCount.deleteMany()
    await prisma.accountClassificationRuleVersionCount.deleteMany()
    await prisma.accountClassificationFreshnessBucket.deleteMany()
    await prisma.accountClassificationReasonCount.deleteMany()
    await prisma.accountClassificationLatest.deleteMany()
    await prisma.accountLabelLatest.deleteMany()
    await prisma.accountLabel.deleteMany()
    await prisma.labelDefinition.deleteMany()
    await prisma.account.deleteMany()
  })

  it('複数 account・複数 update を経た後もトリガー維持テーブルが素朴な集計と一致する', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_trigger_correctness', description: 'テスト用ラベル' },
    })
    for (const id of ['acct_trig_1', 'acct_trig_2']) {
      await prisma.account.create({
        data: {
          id,
          screenName: id,
          displayName: id,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
          lastCrawledAt: new Date(),
        },
      })
    }

    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_1',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.9,
        reason: 'r1',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-13T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:00:00Z'),
      },
      {
        accountId: 'acct_trig_2',
        labelDefinitionId: label.id,
        value: false,
        confidence: 0.2,
        reason: 'r2',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-13T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:00:00Z'),
      },
    ])
    // acct_trig_1 を false へ更新する (value のトリガー decrement/increment を経由させる)。
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_1',
        labelDefinitionId: label.id,
        value: false,
        confidence: 0.3,
        reason: 'r1_updated',
        method: 'rule',
        ruleVersion: 'v2',
        observedAt: new Date('2026-08-13T00:01:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:01:00Z'),
      },
    ])

    const valueCountRows = await prisma.accountClassificationValueCount.findMany({
      where: { labelDefinitionId: label.id },
    })
    const naive = await naiveValueCounts(label.id)
    for (const row of valueCountRows) {
      expect(row.count).toBe(naive.get(row.value) ?? 0)
    }
    expect(valueCountRows.reduce((sum, row) => sum + row.count, 0)).toBe(2)
  })

  it('AccountClassificationLatest の DELETE で4集計テーブルすべてが decrement される', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_trigger_delete', description: 'テスト用ラベル' },
    })
    for (const id of ['acct_trig_del_1', 'acct_trig_del_2']) {
      await prisma.account.create({
        data: {
          id,
          screenName: id,
          displayName: id,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
          lastCrawledAt: new Date(),
        },
      })
    }
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_del_1',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.9,
        reason: 'r1',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-13T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:00:00Z'),
      },
      {
        accountId: 'acct_trig_del_2',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.9,
        reason: 'r2',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-13T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:00:00Z'),
      },
    ])

    await prisma.accountClassificationLatest.delete({
      where: {
        accountId_labelDefinitionId: { accountId: 'acct_trig_del_1', labelDefinitionId: label.id },
      },
    })

    const valueCount = await prisma.accountClassificationValueCount.findUniqueOrThrow({
      where: { labelDefinitionId_value: { labelDefinitionId: label.id, value: true } },
    })
    expect(valueCount.count).toBe(1)
    expect(valueCount.confidenceSum).toBeCloseTo(0.9)

    const ruleVersionCount = await prisma.accountClassificationRuleVersionCount.findUniqueOrThrow({
      where: { labelDefinitionId_ruleVersion: { labelDefinitionId: label.id, ruleVersion: 'v1' } },
    })
    expect(ruleVersionCount.count).toBe(1)

    const freshnessRows = await prisma.accountClassificationFreshnessBucket.findMany({
      where: { labelDefinitionId: label.id },
    })
    expect(freshnessRows.reduce((sum, row) => sum + row.count, 0)).toBe(1)

    const reasonCount = await prisma.accountClassificationReasonCount.findUnique({
      where: { labelDefinitionId_reason: { labelDefinitionId: label.id, reason: 'r1' } },
    })
    expect(reasonCount).toBeNull()

    const reasonCountRemaining = await prisma.accountClassificationReasonCount.findUniqueOrThrow({
      where: { labelDefinitionId_reason: { labelDefinitionId: label.id, reason: 'r2' } },
    })
    expect(reasonCountRemaining.count).toBe(1)
  })

  it('value=false の行を DELETE しても同じ reason の value=true 側の reasonCount は減らない', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_trigger_delete_false', description: 'テスト用ラベル' },
    })
    await prisma.account.create({
      data: {
        id: 'acct_trig_del_false_sibling',
        screenName: 'acct_trig_del_false_sibling',
        displayName: 'acct_trig_del_false_sibling',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date(),
      },
    })
    await prisma.account.create({
      data: {
        id: 'acct_trig_del_false',
        screenName: 'acct_trig_del_false',
        displayName: 'acct_trig_del_false',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date(),
      },
    })
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_del_false_sibling',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.9,
        reason: 'reason_false_delete',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-13T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:00:00Z'),
      },
    ])
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_del_false',
        labelDefinitionId: label.id,
        value: false,
        confidence: 0.1,
        reason: 'reason_false_delete',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-13T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:00:00Z'),
      },
    ])

    await prisma.accountClassificationLatest.delete({
      where: {
        accountId_labelDefinitionId: {
          accountId: 'acct_trig_del_false',
          labelDefinitionId: label.id,
        },
      },
    })

    const reasonCount = await prisma.accountClassificationReasonCount.findUniqueOrThrow({
      where: {
        labelDefinitionId_reason: { labelDefinitionId: label.id, reason: 'reason_false_delete' },
      },
    })
    expect(reasonCount.count).toBe(1)
  })

  it('value/confidence/ruleVersion と分単位バケットが変わらない UPDATE は集計を変えない', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_trigger_noop_update', description: 'テスト用ラベル' },
    })
    await prisma.account.create({
      data: {
        id: 'acct_trig_noop',
        screenName: 'acct_trig_noop',
        displayName: 'acct_trig_noop',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date(),
      },
    })
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_noop',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.9,
        reason: 'r1',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-13T00:00:10Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:00:10Z'),
      },
    ])
    // 同一分内で observedAt だけが微増する再クロールを模す。value/confidence/
    // ruleVersion/reason は変えない。
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_noop',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.9,
        reason: 'r1',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-13T00:00:40Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:00:40Z'),
      },
    ])

    const valueCount = await prisma.accountClassificationValueCount.findUniqueOrThrow({
      where: { labelDefinitionId_value: { labelDefinitionId: label.id, value: true } },
    })
    expect(valueCount.count).toBe(1)
    expect(valueCount.confidenceSum).toBeCloseTo(0.9)

    const freshnessRows = await prisma.accountClassificationFreshnessBucket.findMany({
      where: { labelDefinitionId: label.id },
    })
    expect(freshnessRows.reduce((sum, row) => sum + row.count, 0)).toBe(1)

    const row = await prisma.accountClassificationLatest.findUniqueOrThrow({
      where: {
        accountId_labelDefinitionId: { accountId: 'acct_trig_noop', labelDefinitionId: label.id },
      },
    })
    expect(row.observedAt.toISOString()).toBe('2026-08-13T00:00:40.000Z')

    const reasonRow = await prisma.accountClassificationReasonCount.findUniqueOrThrow({
      where: { labelDefinitionId_reason: { labelDefinitionId: label.id, reason: 'r1' } },
    })
    expect(reasonRow.count).toBe(1)
  })

  it('value=true のまま reason が A→B に変わると A が -1、B が +1 になる', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_trigger_reason_change', description: 'テスト用ラベル' },
    })
    await prisma.account.create({
      data: {
        id: 'acct_trig_reason_change',
        screenName: 'acct_trig_reason_change',
        displayName: 'acct_trig_reason_change',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date(),
      },
    })
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_reason_change',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.9,
        reason: 'reason_a',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-17T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-17T00:00:00Z'),
      },
    ])
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_reason_change',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.9,
        reason: 'reason_b',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-17T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-17T00:00:00Z'),
      },
    ])

    const reasonARow = await prisma.accountClassificationReasonCount.findUnique({
      where: { labelDefinitionId_reason: { labelDefinitionId: label.id, reason: 'reason_a' } },
    })
    expect(reasonARow).toBeNull()

    const reasonBRow = await prisma.accountClassificationReasonCount.findUniqueOrThrow({
      where: { labelDefinitionId_reason: { labelDefinitionId: label.id, reason: 'reason_b' } },
    })
    expect(reasonBRow.count).toBe(1)
  })

  it('value が false→true / true→false と遷移すると reasonCount が正しく増減し、false 側の reason は現れない', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_trigger_reason_value_transition', description: 'テスト用ラベル' },
    })
    await prisma.account.create({
      data: {
        id: 'acct_trig_reason_transition',
        screenName: 'acct_trig_reason_transition',
        displayName: 'acct_trig_reason_transition',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date(),
      },
    })
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_reason_transition',
        labelDefinitionId: label.id,
        value: false,
        confidence: 0.1,
        reason: 'reason_false',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-17T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-17T00:00:00Z'),
      },
    ])
    const afterInsertFalse = await prisma.accountClassificationReasonCount.findUnique({
      where: {
        labelDefinitionId_reason: { labelDefinitionId: label.id, reason: 'reason_false' },
      },
    })
    expect(afterInsertFalse).toBeNull()

    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_reason_transition',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.8,
        reason: 'reason_true',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-17T00:01:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-17T00:01:00Z'),
      },
    ])
    const afterTrue = await prisma.accountClassificationReasonCount.findUniqueOrThrow({
      where: { labelDefinitionId_reason: { labelDefinitionId: label.id, reason: 'reason_true' } },
    })
    expect(afterTrue.count).toBe(1)

    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_trig_reason_transition',
        labelDefinitionId: label.id,
        value: false,
        confidence: 0.1,
        reason: 'reason_false_again',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-17T00:02:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-17T00:02:00Z'),
      },
    ])
    const afterFalseAgain = await prisma.accountClassificationReasonCount.findUnique({
      where: { labelDefinitionId_reason: { labelDefinitionId: label.id, reason: 'reason_true' } },
    })
    expect(afterFalseAgain).toBeNull()
    const newReasonRow = await prisma.accountClassificationReasonCount.findUnique({
      where: {
        labelDefinitionId_reason: { labelDefinitionId: label.id, reason: 'reason_false_again' },
      },
    })
    expect(newReasonRow).toBeNull()
  })

  it('同一 key への並行更新後も逐次実行と同じ集計になる', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_trigger_concurrent', description: 'テスト用ラベル' },
    })
    await prisma.account.create({
      data: {
        id: 'acct_concurrent',
        screenName: 'acct_concurrent',
        displayName: 'acct_concurrent',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date(),
      },
    })
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_concurrent',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.5,
        reason: 'initial',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date('2026-08-13T00:00:00Z'),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date('2026-08-13T00:00:00Z'),
      },
    ])

    // 片方のトランザクションを一時停止させ、もう片方を先に commit させることで
    // 「更新前の値を読んで decrement/increment する」旧方式なら壊れていたはずの
    // 並行 upsert を再現する。
    const txA = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "AccountClassificationLatest" SET "value" = false, "confidence" = 0.1,
          "observedAt" = ${new Date('2026-08-13T00:01:00Z')}
        WHERE "accountId" = 'acct_concurrent' AND "labelDefinitionId" = ${label.id}
      `
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const txB = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        UPDATE "AccountClassificationLatest" SET "value" = true, "confidence" = 0.2,
          "observedAt" = ${new Date('2026-08-13T00:02:00Z')}
        WHERE "accountId" = 'acct_concurrent' AND "labelDefinitionId" = ${label.id}
      `
    })
    await Promise.all([txA, txB])

    const naive = await naiveValueCounts(label.id)
    const valueCountRows = await prisma.accountClassificationValueCount.findMany({
      where: { labelDefinitionId: label.id },
    })
    for (const row of valueCountRows) {
      expect(row.count).toBe(naive.get(row.value) ?? 0)
    }
  })

  it('同一 key への新規 (初回 insert) 並行書き込みも逐次実行と同じ集計になる', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_trigger_concurrent_insert', description: 'テスト用ラベル' },
    })
    await prisma.account.create({
      data: {
        id: 'acct_concurrent_insert',
        screenName: 'acct_concurrent_insert',
        displayName: 'acct_concurrent_insert',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date(),
      },
    })

    const insertRow = (observedAt: Date, value: boolean) =>
      prisma.$transaction(
        (tx) =>
          tx.$executeRaw`
          INSERT INTO "AccountClassificationLatest"
            ("accountId", "labelDefinitionId", "value", "confidence", "reason", "method", "ruleVersion", "observedAt")
          VALUES ('acct_concurrent_insert', ${label.id}, ${value}, 0.5, 'r', 'rule', 'v1', ${observedAt})
          ON CONFLICT ("accountId", "labelDefinitionId") DO UPDATE SET
            "value" = EXCLUDED."value", "confidence" = EXCLUDED."confidence", "observedAt" = EXCLUDED."observedAt"
          WHERE "AccountClassificationLatest"."observedAt" <= EXCLUDED."observedAt"
        `,
      )

    // 2 つの候補書き込みを重ねて実行し、最終的に採用された observedAt 側の
    // value だけが集計されることを検証する (先着した側は WHERE 条件で実際には
    // 更新されず、INSERT トリガーが 1 回だけ発火する)。
    await Promise.all([
      insertRow(new Date('2026-08-13T00:03:00Z'), true),
      insertRow(new Date('2026-08-13T00:04:00Z'), false),
    ])

    const finalRow = await prisma.accountClassificationLatest.findUniqueOrThrow({
      where: {
        accountId_labelDefinitionId: {
          accountId: 'acct_concurrent_insert',
          labelDefinitionId: label.id,
        },
      },
    })
    const naive = await naiveValueCounts(label.id)
    const valueCountRows = await prisma.accountClassificationValueCount.findMany({
      where: { labelDefinitionId: label.id },
    })
    for (const row of valueCountRows) {
      expect(row.count).toBe(naive.get(row.value) ?? 0)
    }
    expect(valueCountRows.reduce((sum, row) => sum + row.count, 0)).toBe(1)
    expect(finalRow.value).toBe(false)
  })

  it('sentinel 行を別トランザクションがロック中でも compaction が待たずに完了する', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_freshness_lock_contention', description: 'テスト用ラベル' },
    })
    await prisma.$executeRaw`
      INSERT INTO "AccountClassificationFreshnessBucket" ("labelDefinitionId", "observedAtBucket", "count")
      VALUES (${label.id}, TIMESTAMP '1970-01-01', 0)
      ON CONFLICT DO NOTHING
    `

    let releaseLock!: () => void
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const holderTx = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT * FROM "AccountClassificationFreshnessBucket"
        WHERE "labelDefinitionId" = ${label.id} AND "observedAtBucket" = TIMESTAMP '1970-01-01'
        FOR UPDATE
      `
      await lockHeld
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const startedAt = Date.now()
    await compactFreshnessBucketsForAllLabelsForTest(prisma, [label.id])
    const elapsedMs = Date.now() - startedAt

    releaseLock()
    await holderTx

    // SKIP LOCKED によりロック中の labelDefinitionId を読み飛ばすため、
    // 別トランザクションが sentinel 行を保持していても解放を待たずに完了する。
    expect(elapsedMs).toBeLessThan(1000)
  })

  it('observedAt が7日境界の前後でバケット割り当てが切り替わる', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_freshness_boundary', description: 'テスト用ラベル' },
    })
    for (const id of ['acct_boundary_fresh', 'acct_boundary_stale']) {
      await prisma.account.create({
        data: {
          id,
          screenName: id,
          displayName: id,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
          lastCrawledAt: new Date(),
        },
      })
    }
    const justUnder7Days = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000 - 60 * 1000))
    const justOver7Days = new Date(Date.now() - (7 * 24 * 60 * 60 * 1000 + 60 * 1000))

    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_boundary_fresh',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.5,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: justUnder7Days,
        sourceObservationId: null,
        evaluable: true,
        labeledAt: justUnder7Days,
      },
      {
        accountId: 'acct_boundary_stale',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.5,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: justOver7Days,
        sourceObservationId: null,
        evaluable: true,
        labeledAt: justOver7Days,
      },
    ])

    const buckets = await prisma.accountClassificationFreshnessBucket.findMany({
      where: { labelDefinitionId: label.id },
    })
    const sentinelBucket = buckets.find(
      (bucket) => bucket.observedAtBucket.getTime() === new Date('1970-01-01T00:00:00Z').getTime(),
    )
    expect(sentinelBucket?.count).toBe(1)
    expect(
      buckets.filter((bucket) => bucket !== sentinelBucket).reduce((sum, b) => sum + b.count, 0),
    ).toBe(1)
  })

  it('追加の書き込みなしで7日を超えたバケットが compaction で sentinel に丸め込まれる', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_compaction_time_only', description: 'テスト用ラベル' },
    })
    await prisma.account.create({
      data: {
        id: 'acct_compaction_stale',
        screenName: 'acct_compaction_stale',
        displayName: 'acct_compaction_stale',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date(),
      },
    })
    const freshAt = new Date(Date.now() - 60 * 60 * 1000)
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_compaction_stale',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.5,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: freshAt,
        sourceObservationId: null,
        evaluable: true,
        labeledAt: freshAt,
      },
    ])
    const literalBucket = new Date(freshAt)
    literalBucket.setUTCSeconds(0, 0)
    // トリガーを再発火させずに「時間経過だけで stale になった」状況を作るため、
    // バケット行を直接 8 日前へ書き換える (アプリケーションコードでは発生しないが、
    // 時間経過のみの境界を単体で確認するためのテスト専用操作)。
    await prisma.$executeRaw`
      UPDATE "AccountClassificationFreshnessBucket"
      SET "observedAtBucket" = ${new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)}
      WHERE "labelDefinitionId" = ${label.id} AND "observedAtBucket" = ${literalBucket}
    `

    await prisma.$transaction((tx) => compactFreshnessBucketsForTest(tx, label.id))

    const buckets = await prisma.accountClassificationFreshnessBucket.findMany({
      where: { labelDefinitionId: label.id },
    })
    expect(buckets).toHaveLength(1)
    expect(buckets[0].observedAtBucket.getTime()).toBe(new Date('1970-01-01T00:00:00Z').getTime())
    expect(buckets[0].count).toBe(1)
  })

  it('compaction とトリガーが並行しても総 count が壊れず、デッドロックしない', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_compaction_concurrent', description: 'テスト用ラベル' },
    })
    for (const id of ['acct_compaction_a', 'acct_compaction_b']) {
      await prisma.account.create({
        data: {
          id,
          screenName: id,
          displayName: id,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
          lastCrawledAt: new Date(),
        },
      })
    }
    const staleAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_compaction_a',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.5,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: staleAt,
        sourceObservationId: null,
        evaluable: true,
        labeledAt: staleAt,
      },
    ])

    const compaction = prisma.$transaction(async (tx) => {
      await compactFreshnessBucketsForTest(tx, label.id)
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // bootstrap 経路を模して、observedAt が 7 日を超える通常の分類更新
    // (トリガー側も sentinel を触るケース) を同時に発火させる。
    const trigger = upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_compaction_b',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.5,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
      },
    ])

    await expect(Promise.all([compaction, trigger])).resolves.toBeDefined()

    const naive = await naiveValueCounts(label.id)
    const valueCountRows = await prisma.accountClassificationValueCount.findMany({
      where: { labelDefinitionId: label.id },
    })
    for (const row of valueCountRows) {
      expect(row.count).toBe(naive.get(row.value) ?? 0)
    }
  })

  it('未 compaction の古いバケットへの再書き込みは sentinel ではなく実際のバケット行から decrement する', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_uncompacted_decrement', description: 'テスト用ラベル' },
    })
    await prisma.account.create({
      data: {
        id: 'acct_uncompacted',
        screenName: 'acct_uncompacted',
        displayName: 'acct_uncompacted',
        followersCount: 0,
        followingCount: 0,
        tweetCount: 0,
        accountCreatedAt: new Date(),
        lastCrawledAt: new Date(),
      },
    })
    const freshAt = new Date(Date.now() - 60 * 60 * 1000)
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_uncompacted',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.5,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: freshAt,
        sourceObservationId: null,
        evaluable: true,
        labeledAt: freshAt,
      },
    ])
    const literalBucket = new Date(freshAt)
    literalBucket.setUTCSeconds(0, 0)
    const agedLiteralBucket = new Date(literalBucket.getTime() - 8 * 24 * 60 * 60 * 1000)

    // このテストの主眼は、バケット行はそのままで実時刻だけが 7 日を超えた
    // 状態を作ることである。トリガーを一時的に無効化し、
    // AccountClassificationLatest.observedAt とバケットのキーを同じ古い時刻に
    // 揃える (compaction は実行しない = まだ sentinel には丸め込まれていない)。
    // 無効化せずに書き換えると、この UPDATE 自体がトリガーを発火させ、
    // 検証したい状態を作る前に集計が変わってしまうため無効化する。
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`ALTER TABLE "AccountClassificationLatest" DISABLE TRIGGER account_classification_latest_aggregate_trigger`
      await tx.$executeRaw`
        UPDATE "AccountClassificationLatest" SET "observedAt" = ${agedLiteralBucket}
        WHERE "accountId" = 'acct_uncompacted' AND "labelDefinitionId" = ${label.id}
      `
      await tx.$executeRaw`
        UPDATE "AccountClassificationFreshnessBucket" SET "observedAtBucket" = ${agedLiteralBucket}
        WHERE "labelDefinitionId" = ${label.id} AND "observedAtBucket" = ${literalBucket}
      `
      await tx.$executeRaw`ALTER TABLE "AccountClassificationLatest" ENABLE TRIGGER account_classification_latest_aggregate_trigger`
    })

    // 同じ account の分類を更新する。OLD.observedAt は上記の書き換えで
    // agedLiteralBucket と揃っているため、date_trunc('minute', OLD.observedAt)
    // は実際に count を保持しているバケット行を正しく指す。トリガーがこのキーの
    // 存在確認を経て decrement することを、バケットの count が正しく 0 になり、
    // sentinel が誤って減算されないことで確認する。
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_uncompacted',
        labelDefinitionId: label.id,
        value: false,
        confidence: 0.9,
        reason: 'updated',
        method: 'rule',
        ruleVersion: 'v2',
        observedAt: new Date(),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date(),
      },
    ])

    const bucketAfterUpdate = await prisma.accountClassificationFreshnessBucket.findUnique({
      where: {
        labelDefinitionId_observedAtBucket: {
          labelDefinitionId: label.id,
          observedAtBucket: agedLiteralBucket,
        },
      },
    })
    const sentinelAfterUpdate = await prisma.accountClassificationFreshnessBucket.findUnique({
      where: {
        labelDefinitionId_observedAtBucket: {
          labelDefinitionId: label.id,
          observedAtBucket: new Date('1970-01-01T00:00:00Z'),
        },
      },
    })
    // 実際に count を保持していたバケット行から decrement された結果、
    // 行自体が削除される (count <= 0)。sentinel は今回の update では触れられない。
    expect(bucketAfterUpdate).toBeNull()
    expect(sentinelAfterUpdate?.count ?? 0).toBe(0)

    await prisma.$transaction((tx) => compactFreshnessBucketsForTest(tx, label.id))
    const naive = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM "AccountClassificationLatest"
      WHERE "labelDefinitionId" = ${label.id}
    `
    const buckets = await prisma.accountClassificationFreshnessBucket.findMany({
      where: { labelDefinitionId: label.id },
    })
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(Number(naive[0].count))
  })

  it('同一分単位バケットを共有する2 account目のbootstrap書き込みは既存バケット行へ増える(sentinelへ分裂しない)', async () => {
    const label = await prisma.labelDefinition.create({
      data: { key: 'test_bucket_split_consistency', description: 'テスト用ラベル' },
    })
    for (const id of ['acct_split_a', 'acct_split_b']) {
      await prisma.account.create({
        data: {
          id,
          screenName: id,
          displayName: id,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
          lastCrawledAt: new Date(),
        },
      })
    }
    const freshAt = new Date(Date.now() - 60 * 60 * 1000)
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_split_a',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.5,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: freshAt,
        sourceObservationId: null,
        evaluable: true,
        labeledAt: freshAt,
      },
    ])
    const literalBucket = new Date(freshAt)
    literalBucket.setUTCSeconds(0, 0)
    // A のバケットが 7 日を超えた状態を、compaction を実行せずに作る。
    const agedBucket = new Date(literalBucket.getTime() - 8 * 24 * 60 * 60 * 1000)
    await prisma.$executeRaw`
      UPDATE "AccountClassificationFreshnessBucket"
      SET "observedAtBucket" = ${agedBucket}
      WHERE "labelDefinitionId" = ${label.id} AND "observedAtBucket" = ${literalBucket}
    `
    // B を、A と同じ分単位に切り捨てられる observedAt (= agedBucket) で
    // bootstrap 相当の初回 insert する。
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_split_b',
        labelDefinitionId: label.id,
        value: true,
        confidence: 0.6,
        reason: 'r',
        method: 'rule',
        ruleVersion: 'v1',
        observedAt: agedBucket,
        sourceObservationId: null,
        evaluable: true,
        labeledAt: agedBucket,
      },
    ])

    const bucketAfterInsert = await prisma.accountClassificationFreshnessBucket.findUniqueOrThrow({
      where: {
        labelDefinitionId_observedAtBucket: {
          labelDefinitionId: label.id,
          observedAtBucket: agedBucket,
        },
      },
    })
    const sentinelAfterInsert = await prisma.accountClassificationFreshnessBucket.findUnique({
      where: {
        labelDefinitionId_observedAtBucket: {
          labelDefinitionId: label.id,
          observedAtBucket: new Date('1970-01-01T00:00:00Z'),
        },
      },
    })
    // B の increment は sentinel ではなく A のバケット行へ加算される。
    expect(bucketAfterInsert.count).toBe(2)
    expect(sentinelAfterInsert?.count ?? 0).toBe(0)

    // B の分類を更新し、その decrement も同じバケット行から行われることを確認する。
    await upsertAccountClassificationLatest(prisma, [
      {
        accountId: 'acct_split_b',
        labelDefinitionId: label.id,
        value: false,
        confidence: 0.1,
        reason: 'updated',
        method: 'rule',
        ruleVersion: 'v2',
        observedAt: new Date(),
        sourceObservationId: null,
        evaluable: true,
        labeledAt: new Date(),
      },
    ])
    const bucketAfterDecrement =
      await prisma.accountClassificationFreshnessBucket.findUniqueOrThrow({
        where: {
          labelDefinitionId_observedAtBucket: {
            labelDefinitionId: label.id,
            observedAtBucket: agedBucket,
          },
        },
      })
    expect(bucketAfterDecrement.count).toBe(1)

    await prisma.$transaction((tx) => compactFreshnessBucketsForTest(tx, label.id))
    const naive = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM "AccountClassificationLatest" WHERE "labelDefinitionId" = ${label.id}
    `
    const buckets = await prisma.accountClassificationFreshnessBucket.findMany({
      where: { labelDefinitionId: label.id },
    })
    expect(buckets.reduce((sum, b) => sum + b.count, 0)).toBe(Number(naive[0].count))
  })

  it('複数labelDefinitionIdを含む更新が逆順で重なってもデッドロックしない', async () => {
    const labelX = await prisma.labelDefinition.create({
      data: { key: 'test_deadlock_x', description: 'テスト用ラベルX' },
    })
    const labelY = await prisma.labelDefinition.create({
      data: { key: 'test_deadlock_y', description: 'テスト用ラベルY' },
    })
    for (const id of ['acct_deadlock_1', 'acct_deadlock_2']) {
      await prisma.account.create({
        data: {
          id,
          screenName: id,
          displayName: id,
          followersCount: 0,
          followingCount: 0,
          tweetCount: 0,
          accountCreatedAt: new Date(),
          lastCrawledAt: new Date(),
        },
      })
    }
    const now = new Date()
    const baseRow = (accountId: string, labelDefinitionId: string, value: boolean) => ({
      accountId,
      labelDefinitionId,
      value,
      confidence: 0.5,
      reason: 'r',
      method: 'rule',
      ruleVersion: 'v1',
      observedAt: now,
      sourceObservationId: null,
      evaluable: true,
      labeledAt: now,
    })
    await upsertAccountClassificationLatest(prisma, [
      baseRow('acct_deadlock_1', labelX.id, true),
      baseRow('acct_deadlock_1', labelY.id, true),
      baseRow('acct_deadlock_2', labelX.id, true),
      baseRow('acct_deadlock_2', labelY.id, true),
    ])

    // labelDefinitionId をまたぐロック順序の一貫性は、トリガー自体ではなく
    // upsertAccountClassificationLatest が常に labelDefinitionId 昇順で
    // INSERT する choke point によって保証される契約である。
    // ここでは呼び出し元がそれぞれ逆順で行を渡しても (acct_deadlock_1 は
    // Y→X、acct_deadlock_2 は X→Y)、choke point 内部のソートにより
    // 実際の書き込み順序は両者とも X→Y に揃うため、デッドロックしないことを検証する。
    const later = new Date(now.getTime() + 60 * 1000)
    const updateForward = upsertAccountClassificationLatest(
      prisma,
      [
        baseRow('acct_deadlock_1', labelY.id, false),
        baseRow('acct_deadlock_1', labelX.id, false),
      ].map((row) => ({ ...row, observedAt: later })),
    )
    const updateBackward = upsertAccountClassificationLatest(
      prisma,
      [
        baseRow('acct_deadlock_2', labelX.id, false),
        baseRow('acct_deadlock_2', labelY.id, false),
      ].map((row) => ({ ...row, observedAt: later })),
    )

    await expect(Promise.all([updateForward, updateBackward])).resolves.toBeDefined()

    for (const label of [labelX, labelY]) {
      const naive = await naiveValueCounts(label.id)
      const valueCountRows = await prisma.accountClassificationValueCount.findMany({
        where: { labelDefinitionId: label.id },
      })
      for (const row of valueCountRows) {
        expect(row.count).toBe(naive.get(row.value) ?? 0)
      }
    }
  })
})

describe.skipIf(!process.env.DATABASE_URL)(
  'buildLabelAggregateSnapshotSet output compatibility',
  () => {
    const prisma = getPrismaClient()

    beforeEach(async () => {
      await prisma.labelMetricSnapshot.deleteMany()
      await prisma.accountClassificationValueCount.deleteMany()
      await prisma.accountClassificationConfidenceBucketCount.deleteMany()
      await prisma.accountClassificationRuleVersionCount.deleteMany()
      await prisma.accountClassificationFreshnessBucket.deleteMany()
      await prisma.accountClassificationReasonCount.deleteMany()
      await prisma.accountClassificationLatest.deleteMany()
      await prisma.accountSummaryLatest.deleteMany()
      await prisma.accountLabelLatest.deleteMany()
      await prisma.accountLabel.deleteMany()
      await prisma.labelDefinition.deleteMany()
      await prisma.account.deleteMany()
    })

    it('新しい読み取り経路で構築したsnapshotが旧実装相当の直接集計と同じ値になる', async () => {
      const label = await prisma.labelDefinition.create({
        data: { key: 'test_output_compat', description: 'テスト用ラベル' },
      })
      const now = new Date()
      for (const [id, value, confidence, ruleVersion, ageMs] of [
        ['acct_compat_1', true, 0.91, 'v1', 60 * 60 * 1000],
        ['acct_compat_2', true, 0.42, 'v2', 6 * 60 * 60 * 1000],
        ['acct_compat_3', false, 0.15, 'v1', 24 * 60 * 60 * 1000],
      ] as const) {
        await prisma.account.create({
          data: {
            id,
            screenName: id,
            displayName: id,
            followersCount: 0,
            followingCount: 0,
            tweetCount: 0,
            accountCreatedAt: new Date(),
            lastCrawledAt: new Date(),
          },
        })
        await prisma.accountSummaryLatest.create({
          data: {
            accountId: id,
            normalizedScreenName: id,
            normalizedDisplayName: id,
            searchDocument: id,
            profileObservedAt: now,
            activeLabelKeys: [],
            activeLabelCount: 0,
            classificationObservedAt: now,
          },
        })
        await prisma.accountClassificationLatest.create({
          data: {
            accountId: id,
            labelDefinitionId: label.id,
            value,
            confidence,
            reason: `reason_${id}`,
            method: 'rule',
            ruleVersion,
            observedAt: new Date(now.getTime() - ageMs),
          },
        })
      }

      const freshnessThresholdsMs = {
        delayedAfterMs: 3 * 60 * 60 * 1000,
        staleAfterMs: 12 * 60 * 60 * 1000,
      }
      const result = await buildLabelAggregateSnapshotSet(prisma, {
        triggerWorkItemId: 'work_item_output_compat',
        policyHash: 'hash',
        analyzerVersion: 'test',
        thresholds: { minCoverage: 0, maxStaleRatio: 1 },
        freshnessThresholdsMs,
      })
      const snapshot = await prisma.labelMetricSnapshot.findFirstOrThrow({
        where: { triggerWorkItemId: 'work_item_output_compat', labelDefinitionId: label.id },
      })

      // 旧実装と同じ SQL 形状 (AccountClassificationLatest を直接 GROUP BY) で
      // 期待値を計算する参照クエリ。
      const referenceRows = await prisma.$queryRaw<
        {
          value: boolean
          reason: string
          ruleVersion: string
          count: bigint
          confidenceSum: number
        }[]
      >`
      SELECT "value", "reason", "ruleVersion", COUNT(*) AS count, SUM("confidence") AS "confidenceSum"
      FROM "AccountClassificationLatest"
      WHERE "labelDefinitionId" = ${label.id}
      GROUP BY 1, 2, 3
    `
      const expectedEvaluatedCount = referenceRows.reduce((sum, row) => sum + Number(row.count), 0)
      const expectedTrueCount = referenceRows
        .filter((row) => row.value)
        .reduce((sum, row) => sum + Number(row.count), 0)
      const expectedReasonDistribution: Record<string, number> = {}
      for (const row of referenceRows.filter((row) => row.value)) {
        expectedReasonDistribution[row.reason] =
          (expectedReasonDistribution[row.reason] ?? 0) + Number(row.count)
      }

      expect(result.reused).toBe(false)
      expect(snapshot.evaluatedCount).toBe(expectedEvaluatedCount)
      expect(snapshot.trueCount).toBe(expectedTrueCount)
      expect(snapshot.reasonDistribution).toEqual(expectedReasonDistribution)
    })
  },
)
