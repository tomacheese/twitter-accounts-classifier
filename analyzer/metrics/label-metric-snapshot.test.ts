import { describe, it, expect, beforeEach } from 'vitest'
import { getPrismaClient } from '../db/client'
import {
  buildLabelAggregateSnapshotSet,
  deriveCompletenessFromCoverage,
} from './label-metric-snapshot'

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

describe.skipIf(!process.env.DATABASE_URL)('buildLabelAggregateSnapshotSet', () => {
  const prisma = getPrismaClient()

  beforeEach(async () => {
    await prisma.labelMetricSnapshot.deleteMany()
    await prisma.accountClassificationLatest.deleteMany()
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
})
