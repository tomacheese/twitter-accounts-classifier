import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '../generated/prisma'
import { loadWeeklyReviewPlanningData } from './review-plan-data'
import { PrismaWeeklyReviewPlanningDataSource } from './prisma-review-plan-data-source'

const prisma = new PrismaClient()

afterAll(async () => {
  await prisma.$disconnect()
})

describe.skipIf(!process.env.DATABASE_URL)('PrismaWeeklyReviewPlanningDataSource', () => {
  it('candidate pool size が小さくても label ごとに true/false 両方の候補を読む', async () => {
    const suffix = randomUUID().slice(0, 8)
    const labelKey = `weekly_review_balanced_${suffix}`
    const label = await prisma.labelDefinition.create({
      data: {
        key: labelKey,
        description: '架空の balanced candidate テストラベル',
        currentRuleVersion: '1.0.0',
      },
    })
    const targetFrom = new Date('2026-08-01T00:00:00Z')
    const targetTo = new Date('2026-08-08T00:00:00Z')
    const accountIds = [`balanced_true_${suffix}`, `balanced_false_${suffix}`]

    try {
      for (const accountId of accountIds) {
        await prisma.account.create({
          data: {
            id: accountId,
            screenName: accountId,
            displayName: 'Synthetic Account',
            followersCount: 1,
            followingCount: 1,
            tweetCount: 1,
            accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
          },
        })
      }
      await prisma.accountLabel.createMany({
        data: [
          {
            accountId: accountIds[0],
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.8,
            reason: 'synthetic positive',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt: new Date('2026-08-02T00:00:00Z'),
          },
          {
            accountId: accountIds[1],
            labelDefinitionId: label.id,
            value: false,
            confidence: 0.1,
            reason: 'synthetic negative',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt: new Date('2026-08-07T00:00:00Z'),
          },
        ],
      })

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      const candidates = await source.listRecentCandidates(targetFrom, targetTo, 1, 'balanced-seed')
      const own = candidates.filter((candidate) => candidate.labelDefinitionId === label.id)

      expect(own.map((candidate) => candidate.value).toSorted()).toEqual([false, true])
    } finally {
      await prisma.accountLabel.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
      await prisma.labelDefinition.deleteMany({ where: { id: label.id } })
    }
  })

  it('候補探索は label ごとの直近 poolSize*10 行より古い履歴まで走査しない', async () => {
    const suffix = randomUUID().slice(0, 8)
    const label = await prisma.labelDefinition.create({
      data: {
        key: `weekly_review_bounded_${suffix}`,
        description: '架空の bounded candidate テストラベル',
        currentRuleVersion: '1.0.0',
      },
    })
    const targetFrom = new Date('2026-08-01T00:00:00Z')
    const targetTo = new Date('2026-08-08T00:00:00Z')
    const accountIds = Array.from({ length: 12 }, (_, index) => `bounded_${index}_${suffix}`)

    try {
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
      await prisma.accountLabel.createMany({
        data: [
          {
            accountId: accountIds[0],
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.8,
            reason: 'synthetic older positive',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt: new Date('2026-08-02T00:00:00Z'),
          },
          ...accountIds.slice(1).map((accountId, index) => ({
            accountId,
            labelDefinitionId: label.id,
            value: false,
            confidence: 0.1,
            reason: 'synthetic recent negative',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt: new Date(`2026-08-07T00:${String(index).padStart(2, '0')}:00Z`),
          })),
        ],
      })

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      const candidates = await source.listRecentCandidates(targetFrom, targetTo, 1, 'bounded-seed')
      const own = candidates.filter((candidate) => candidate.labelDefinitionId === label.id)

      expect(own.map((candidate) => candidate.value)).toEqual([false])
      expect(own[0]?.accountId).not.toBe(accountIds[0])
    } finally {
      await prisma.accountLabel.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
      await prisma.labelDefinition.deleteMany({ where: { id: label.id } })
    }
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
      await prisma.labelAggregate.create({
        data: {
          labelDefinitionId: label.id,
          labelKey,
          labelDescription: '架空の週次レビューテストラベル',
          trueCount: 1,
          totalCount: 10,
          updatedAt: now,
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
      await prisma.accountLabel.create({
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
        trueCount: 1,
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
      await prisma.accountLabel.deleteMany({ where: { accountId } })
      await prisma.reviewFinding.deleteMany({ where: { fingerprint: findingFingerprint } })
      await prisma.labelMetricSnapshot.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.labelAggregate.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.account.deleteMany({ where: { id: accountId } })
      await prisma.labelDefinition.deleteMany({ where: { id: label.id } })
    }
  })
})
