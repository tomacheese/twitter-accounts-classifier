import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '../generated/prisma'
import { loadWeeklyReviewPlanningData } from './review-plan-data'
import { PrismaWeeklyReviewPlanningDataSource } from './prisma-review-plan-data-source'

interface SyntheticClassificationRow {
  accountId: string
  labelDefinitionId: string
  value: boolean
  confidence: number
  reason: string
  method: string
  ruleVersion: string
  observedAt: Date
  evaluable: boolean
  labeledAt: Date | null
}

const prisma = new PrismaClient()

async function createAccounts(accountIds: string[]): Promise<void> {
  await prisma.account.createMany({
    data: accountIds.map((accountId) => ({
      id: accountId,
      screenName: accountId,
      displayName: 'Synthetic Account',
      followersCount: 1,
      followingCount: 1,
      tweetCount: 1,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
    })),
  })
}

async function createClassifications(data: SyntheticClassificationRow[]): Promise<void> {
  await prisma.accountClassificationLatest.createMany({ data })
}

async function cleanupLabel(labelId: string, accountIds: string[]): Promise<void> {
  await prisma.accountClassificationLatest.deleteMany({ where: { labelDefinitionId: labelId } })
  await prisma.weeklyReviewSampleBucketCount.deleteMany({ where: { labelDefinitionId: labelId } })
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.labelDefinition.deleteMany({ where: { id: labelId } })
}

afterAll(async () => {
  await prisma.$disconnect()
})

describe.skipIf(!process.env.DATABASE_URL)('PrismaWeeklyReviewPlanningDataSource', () => {
  describe('listBaselineCandidates', () => {
    it('evaluable=false または labeledAt が null の行は候補に含まない', async () => {
      const suffix = randomUUID().slice(0, 8)
      const label = await prisma.labelDefinition.create({
        data: {
          key: `weekly_review_eligibility_${suffix}`,
          description: '架空の eligibility テストラベル',
          currentRuleVersion: '1.0.0',
        },
      })
      const eligibleId = `eligible_${suffix}`
      const notEvaluableId = `not_evaluable_${suffix}`
      const noLabeledAtId = `no_labeled_at_${suffix}`
      const accountIds = [eligibleId, notEvaluableId, noLabeledAtId]
      const observedAt = new Date('2026-08-07T00:00:00Z')

      try {
        await createAccounts(accountIds)
        await createClassifications([
          {
            accountId: eligibleId,
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.8,
            reason: 'synthetic eligible',
            method: 'rule',
            ruleVersion: '1.0.0',
            observedAt,
            evaluable: true,
            labeledAt: observedAt,
          },
          {
            accountId: notEvaluableId,
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.8,
            reason: 'synthetic not evaluable',
            method: 'rule',
            ruleVersion: '1.0.0',
            observedAt,
            evaluable: false,
            labeledAt: observedAt,
          },
          {
            accountId: noLabeledAtId,
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.8,
            reason: 'synthetic missing labeledAt',
            method: 'rule',
            ruleVersion: '1.0.0',
            observedAt,
            evaluable: true,
            labeledAt: null,
          },
        ])

        const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
        const candidates = await source.listBaselineCandidates(50, 'eligibility-seed')
        const own = candidates.filter((candidate) => candidate.labelDefinitionId === label.id)

        expect(own.map((candidate) => candidate.accountId)).toEqual([eligibleId])
      } finally {
        await cleanupLabel(label.id, accountIds)
      }
    })

    it('同じ seed なら同じ candidate 集合を返す', async () => {
      const suffix = randomUUID().slice(0, 8)
      const label = await prisma.labelDefinition.create({
        data: {
          key: `weekly_review_stable_seed_${suffix}`,
          description: '架空の seed 安定性テストラベル',
          currentRuleVersion: '1.0.0',
        },
      })
      const accountIds = Array.from({ length: 20 }, (_, index) => `stable_${index}_${suffix}`)
      const observedAt = new Date('2026-08-07T00:00:00Z')

      try {
        await createAccounts(accountIds)
        await createClassifications(
          accountIds.map((accountId) => ({
            accountId,
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.8,
            reason: 'synthetic stable seed',
            method: 'rule',
            ruleVersion: '1.0.0',
            observedAt,
            evaluable: true,
            labeledAt: observedAt,
          })),
        )

        const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
        const first = await source.listBaselineCandidates(5, 'stable-seed')
        const second = await source.listBaselineCandidates(5, 'stable-seed')
        const ownFirst = first
          .filter((candidate) => candidate.labelDefinitionId === label.id)
          .map((candidate) => candidate.accountId)
          .toSorted()
        const ownSecond = second
          .filter((candidate) => candidate.labelDefinitionId === label.id)
          .map((candidate) => candidate.accountId)
          .toSorted()

        expect(ownSecond).toEqual(ownFirst)
      } finally {
        await cleanupLabel(label.id, accountIds)
      }
    })

    it('母集団が小さい stratum では追加 bucket を読まず、実在する候補だけを返す', async () => {
      const suffix = randomUUID().slice(0, 8)
      const label = await prisma.labelDefinition.create({
        data: {
          key: `weekly_review_insufficient_${suffix}`,
          description: '架空の候補不足テストラベル',
          currentRuleVersion: '1.0.0',
        },
      })
      const accountIds = Array.from({ length: 5 }, (_, index) => `sparse_${index}_${suffix}`)
      const observedAt = new Date('2026-08-07T00:00:00Z')

      try {
        await createAccounts(accountIds)
        await createClassifications(
          accountIds.map((accountId) => ({
            accountId,
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.8,
            reason: 'synthetic sparse population',
            method: 'rule',
            ruleVersion: '1.0.0',
            observedAt,
            evaluable: true,
            labeledAt: observedAt,
          })),
        )

        const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
        const candidates = await source.listBaselineCandidates(50, 'sparse-seed')
        const own = candidates.filter((candidate) => candidate.labelDefinitionId === label.id)

        expect(own).toHaveLength(accountIds.length)
        expect(own.length).toBeLessThan(50)
      } finally {
        await cleanupLabel(label.id, accountIds)
      }
    })
  })

  describe('listPopulationCounts', () => {
    it('WeeklyReviewSampleBucketCount の合計値と一致する', async () => {
      const suffix = randomUUID().slice(0, 8)
      const label = await prisma.labelDefinition.create({
        data: {
          key: `weekly_review_population_${suffix}`,
          description: '架空の population count テストラベル',
          currentRuleVersion: '1.0.0',
        },
      })
      const trueIds = Array.from({ length: 3 }, (_, index) => `population_true_${index}_${suffix}`)
      const falseIds = Array.from(
        { length: 2 },
        (_, index) => `population_false_${index}_${suffix}`,
      )
      const accountIds = [...trueIds, ...falseIds]
      const observedAt = new Date('2026-08-07T00:00:00Z')

      try {
        await createAccounts(accountIds)
        await createClassifications([
          ...trueIds.map((accountId) => ({
            accountId,
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.8,
            reason: 'synthetic positive',
            method: 'rule',
            ruleVersion: '1.0.0',
            observedAt,
            evaluable: true,
            labeledAt: observedAt,
          })),
          ...falseIds.map((accountId) => ({
            accountId,
            labelDefinitionId: label.id,
            value: false,
            confidence: 0.1,
            reason: 'synthetic negative',
            method: 'rule',
            ruleVersion: '1.0.0',
            observedAt,
            evaluable: true,
            labeledAt: observedAt,
          })),
        ])

        const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
        const populationCounts = await source.listPopulationCounts()
        const trueRow = populationCounts.find(
          (row) => row.labelDefinitionId === label.id && row.value,
        )
        const falseRow = populationCounts.find(
          (row) => row.labelDefinitionId === label.id && !row.value,
        )
        const bucketCounts = await prisma.weeklyReviewSampleBucketCount.findMany({
          where: { labelDefinitionId: label.id },
        })
        const expectedTrue = bucketCounts
          .filter((row) => row.value)
          .reduce((sum, row) => sum + row.count, 0)
        const expectedFalse = bucketCounts
          .filter((row) => !row.value)
          .reduce((sum, row) => sum + row.count, 0)

        expect(trueRow?.count).toBe(expectedTrue)
        expect(falseRow?.count).toBe(expectedFalse)
        expect(trueRow?.count).toBe(3)
        expect(falseRow?.count).toBe(2)
      } finally {
        await cleanupLabel(label.id, accountIds)
      }
    })
  })

  describe('assertSamplingReady', () => {
    const bootstrapModelKey = 'account_summary_v2'
    const stateModelKey = 'account_summary_latest'

    afterAll(async () => {
      await prisma.readModelBootstrap.deleteMany({ where: { modelKey: bootstrapModelKey } })
      await prisma.readModelState.deleteMany({ where: { modelKey: stateModelKey } })
    })

    it('bootstrap が completed かつ read model が healthy/schemaVersion>=2 なら解決する', async () => {
      await prisma.readModelBootstrap.upsert({
        where: { modelKey: bootstrapModelKey },
        create: { modelKey: bootstrapModelKey, status: 'completed' },
        update: { status: 'completed' },
      })
      await prisma.readModelState.upsert({
        where: { modelKey: stateModelKey },
        create: { modelKey: stateModelKey, schemaVersion: 2, status: 'healthy' },
        update: { schemaVersion: 2, status: 'healthy' },
      })

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      await expect(source.assertSamplingReady()).resolves.toBeUndefined()
    })

    it('bootstrap が completed でなければ拒否する', async () => {
      await prisma.readModelBootstrap.upsert({
        where: { modelKey: bootstrapModelKey },
        create: { modelKey: bootstrapModelKey, status: 'running' },
        update: { status: 'running' },
      })
      await prisma.readModelState.upsert({
        where: { modelKey: stateModelKey },
        create: { modelKey: stateModelKey, schemaVersion: 2, status: 'healthy' },
        update: { schemaVersion: 2, status: 'healthy' },
      })

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      await expect(source.assertSamplingReady()).rejects.toThrow()
    })

    it('read model の schemaVersion が 2 未満なら拒否する', async () => {
      await prisma.readModelBootstrap.upsert({
        where: { modelKey: bootstrapModelKey },
        create: { modelKey: bootstrapModelKey, status: 'completed' },
        update: { status: 'completed' },
      })
      await prisma.readModelState.upsert({
        where: { modelKey: stateModelKey },
        create: { modelKey: stateModelKey, schemaVersion: 1, status: 'healthy' },
        update: { schemaVersion: 1, status: 'healthy' },
      })

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      await expect(source.assertSamplingReady()).rejects.toThrow()
    })

    it('read model の status が healthy でなければ拒否する', async () => {
      await prisma.readModelBootstrap.upsert({
        where: { modelKey: bootstrapModelKey },
        create: { modelKey: bootstrapModelKey, status: 'completed' },
        update: { status: 'completed' },
      })
      await prisma.readModelState.upsert({
        where: { modelKey: stateModelKey },
        create: { modelKey: stateModelKey, schemaVersion: 2, status: 'degraded' },
        update: { schemaVersion: 2, status: 'degraded' },
      })

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      await expect(source.assertSamplingReady()).rejects.toThrow()
    })
  })

  describe('readSnapshotAt', () => {
    it('現在時刻に近い DB 時刻を返す', async () => {
      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      const before = Date.now()
      const snapshotAt = await source.readSnapshotAt()
      const after = Date.now()

      expect(snapshotAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
      expect(snapshotAt.getTime()).toBeLessThanOrEqual(after + 1000)
    })
  })

  it('最新 metrics・active finding・recent change・candidate pool を同じ label に統合する', async () => {
    const suffix = randomUUID().slice(0, 8)
    const labelKey = `weekly_review_test_${suffix}`
    const accountId = `test_${suffix}`
    const now = new Date('2026-08-08T00:00:00Z')
    const previous = new Date('2026-08-01T00:00:00Z')
    const triggerA = `trigger_a_${suffix}`
    const triggerB = `trigger_b_${suffix}`
    const findingFingerprint = `weekly-review-test-${suffix}`
    const label = await prisma.labelDefinition.create({
      data: {
        key: labelKey,
        description: '架空の週次レビューテストラベル',
        currentRuleVersion: '2.0.0',
      },
    })

    try {
      await prisma.account.create({
        data: {
          id: accountId,
          screenName: `test_user_${suffix}`,
          displayName: `Test User ${suffix}`,
          followersCount: 10,
          followingCount: 5,
          tweetCount: 20,
          accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
        },
      })
      await prisma.labelMetricSnapshot.createMany({
        data: [
          {
            triggerWorkItemId: triggerA,
            labelDefinitionId: label.id,
            observedAt: previous,
            sourceWatermarkAt: previous,
            evaluatedCount: 10,
            trueCount: 1,
            prevalence: 0.1,
            coverage: 0.95,
            staleRatio: 0,
            completeness: 'complete',
            policyHash: 'test-policy',
            analyzerVersion: 'test-analyzer',
          },
          {
            triggerWorkItemId: triggerB,
            labelDefinitionId: label.id,
            observedAt: now,
            sourceWatermarkAt: now,
            evaluatedCount: 10,
            trueCount: 2,
            prevalence: 0.2,
            coverage: 0.8,
            staleRatio: 0.1,
            completeness: 'complete',
            policyHash: 'test-policy',
            analyzerVersion: 'test-analyzer',
          },
        ],
      })
      await prisma.reviewFinding.create({
        data: {
          fingerprint: findingFingerprint,
          identityVersion: 1,
          type: 'possible_false_positive',
          primaryScopeType: 'label',
          primaryScopeId: label.id,
          currentSeverity: 'medium',
          maximumSeverity: 'medium',
        },
      })
      await prisma.accountClassificationLatest.create({
        data: {
          accountId,
          labelDefinitionId: label.id,
          value: false,
          confidence: 0.7,
          reason: 'synthetic near miss',
          method: 'rule',
          ruleVersion: '2.0.0',
          observedAt: now,
          evaluable: true,
          labeledAt: now,
        },
      })
      // listChangeCandidates は AccountLabelLatest の PK join を維持するため、
      // change candidate 側の検証にはこちらの table も合わせて用意する。
      await prisma.accountLabelLatest.create({
        data: {
          accountId,
          labelDefinitionId: label.id,
          value: false,
          confidence: 0.7,
          reason: 'synthetic near miss',
          method: 'rule',
          ruleVersion: '2.0.0',
          labeledAt: now,
        },
      })
      await prisma.accountLabelChange.createMany({
        data: [
          {
            accountId,
            labelDefinitionId: label.id,
            changeType: 'added',
            previousValue: false,
            newValue: true,
            changedAt: previous,
          },
          {
            accountId,
            labelDefinitionId: label.id,
            changeType: 'removed',
            previousValue: true,
            newValue: false,
            changedAt: now,
          },
        ],
      })

      const data = await loadWeeklyReviewPlanningData(
        new PrismaWeeklyReviewPlanningDataSource(prisma),
        { targetFrom: previous, targetTo: now, candidatePoolSize: 20, seed: 'integration-seed' },
      )
      const plannedLabel = data.labels.find((item) => item.id === label.id)
      const plannedCandidate = data.candidates.find(
        (item) => item.labelDefinitionId === label.id && item.accountId === accountId,
      )

      expect(plannedLabel).toMatchObject({
        trueCount: 2,
        totalCount: 10,
        activeFindingCount: 1,
        recentChangeCount: 2,
        latestMetrics: { prevalence: 0.2, coverage: 0.8, staleRatio: 0.1 },
        previousMetrics: { prevalence: 0.1, coverage: 0.95, staleRatio: 0 },
      })
      expect(plannedCandidate).toMatchObject({
        value: false,
        confidence: 0.7,
        changeType: 'removed',
      })
    } finally {
      await prisma.accountLabelChange.deleteMany({ where: { accountId } })
      await prisma.accountLabelLatest.deleteMany({ where: { accountId } })
      await prisma.accountClassificationLatest.deleteMany({ where: { accountId } })
      await prisma.weeklyReviewSampleBucketCount.deleteMany({
        where: { labelDefinitionId: label.id },
      })
      await prisma.reviewFinding.deleteMany({ where: { fingerprint: findingFingerprint } })
      await prisma.labelMetricSnapshot.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.account.deleteMany({ where: { id: accountId } })
      await prisma.labelDefinition.deleteMany({ where: { id: label.id } })
    }
  })
})
