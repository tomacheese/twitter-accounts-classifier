import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getPrismaClient } from '../db/client'
import { upsertAccountClassificationLatest } from '../read-models/account-summary-latest'
import {
  buildLabelAggregateSnapshotSet,
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
  it('reads population count from AccountSummaryLatest and aggregates from the 4 count tables', async () => {
    const snapshotAt = new Date('2026-08-09T00:00:00Z')
    const queryRaw = vi.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?')
      if (sql.includes('SELECT now() AS now')) return Promise.resolve([{ now: snapshotAt }])
      if (sql.includes('FROM "AccountClassificationFreshnessBucket"') && sql.includes('WHERE'))
        return Promise.resolve([])
      if (sql.includes('FROM "AccountSummaryLatest"')) return Promise.resolve([{ count: 1n }])
      return Promise.resolve([])
    })
    const executeRaw = vi.fn(() => Promise.resolve(0))
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

    const populationQuery = queryRaw.mock.calls
      .map((call) => call[0].join('?'))
      .find((sql: string) => sql.includes('FROM "AccountSummaryLatest"'))
    expect(populationQuery).toContain('classificationObservedAt')
    expect(executeRaw.mock.calls[0][0].join('?')).toContain("SET LOCAL work_mem = '256MB'")
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
      expect.objectContaining({ isolationLevel: 'RepeatableRead', timeout: 300_000 }),
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
      prisma.$transaction((tx) =>
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
        accountId_labelDefinitionId: { accountId: 'acct_concurrent_insert', labelDefinitionId: label.id },
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
})
