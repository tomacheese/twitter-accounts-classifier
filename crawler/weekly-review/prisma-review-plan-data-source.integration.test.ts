import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { PrismaClient } from '../generated/prisma'
import { loadWeeklyReviewPlanningData } from './review-plan-data'
import { PrismaWeeklyReviewPlanningDataSource } from './prisma-review-plan-data-source'

interface SyntheticLabelRow {
  accountId: string
  labelDefinitionId: string
  value: boolean
  confidence: number
  reason: string
  method: string
  ruleVersion: string
  labeledAt: Date
  evaluable?: boolean
}

const prisma = new PrismaClient()

async function createLabelHistoryAndLatest(data: SyntheticLabelRow[]): Promise<void> {
  await prisma.accountLabel.createMany({ data })
  await prisma.accountLabelLatest.createMany({ data })
}

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
      await createLabelHistoryAndLatest([
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
      ])

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      const candidates = await source.listRecentCandidates(targetFrom, targetTo, 1, 'balanced-seed')
      const own = candidates.filter((candidate) => candidate.labelDefinitionId === label.id)

      expect(own.map((candidate) => candidate.value).toSorted()).toEqual([false, true])
    } finally {
      await prisma.accountLabelLatest.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.accountLabel.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
      await prisma.labelDefinition.deleteMany({ where: { id: label.id } })
    }
  })

  it('poolSize*10 の LIMIT で除外されていた古い candidate も value ごとの候補に含める', async () => {
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
      await createLabelHistoryAndLatest([
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
      ])

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      const candidates = await source.listRecentCandidates(targetFrom, targetTo, 1, 'bounded-seed')
      const own = candidates.filter((candidate) => candidate.labelDefinitionId === label.id)

      // value ごとの stratum を取る前に全体を LIMIT で絞り込む実装だと、
      // 唯一の value=true 候補が母集団最古の場合にその LIMIT で除外され得る境界ケース。
      expect(own.map((candidate) => candidate.value).toSorted()).toEqual([false, true])
      expect(own.find((candidate) => candidate.value)?.accountId).toBe(accountIds[0])
    } finally {
      await prisma.accountLabelLatest.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.accountLabel.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
      await prisma.labelDefinition.deleteMany({ where: { id: label.id } })
    }
  })

  it('候補探索は LIMIT poolSize*10 で切り詰めた最新部分集合ではなく期間内全件からサンプリングする', async () => {
    const suffix = randomUUID().slice(0, 8)
    const label = await prisma.labelDefinition.create({
      data: {
        key: `weekly_review_full_frame_${suffix}`,
        description: '架空の full-frame candidate テストラベル',
        currentRuleVersion: '1.0.0',
      },
    })
    const targetFrom = new Date('2026-08-01T00:00:00Z')
    const targetTo = new Date('2026-08-08T00:00:00Z')
    const populationSize = 200
    const accountIds = Array.from(
      { length: populationSize },
      (_, index) => `frame_${index}_${suffix}`,
    )
    // labeledAt はインデックスが大きいほど新しいので、newest 50 件は index 150〜199。
    const newestFiftyThreshold = new Date(targetFrom.getTime() + 150 * 1000)

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
      await createLabelHistoryAndLatest(
        accountIds.map((accountId, index) => ({
          accountId,
          labelDefinitionId: label.id,
          value: false,
          confidence: 0.1,
          reason: 'synthetic full-frame negative',
          method: 'rule',
          ruleVersion: '1.0.0',
          labeledAt: new Date(targetFrom.getTime() + index * 1000),
        })),
      )

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      const rows = await source.listRecentCandidates(targetFrom, targetTo, 5, 'full-frame-seed')
      const own = rows.filter((row) => row.labelDefinitionId === label.id)

      expect(own.length).toBeLessThanOrEqual(10)
      const oldestSelectedLabeledAt = Math.min(...own.map((row) => row.labeledAt.getTime()))
      expect(oldestSelectedLabeledAt).toBeLessThan(newestFiftyThreshold.getTime())
    } finally {
      await prisma.accountLabelLatest.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.accountLabel.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
      await prisma.labelDefinition.deleteMany({ where: { id: label.id } })
    }
  })

  it('targetTo 後に Latest が更新されても targetTo 時点の履歴行を candidate に使う', async () => {
    const suffix = randomUUID().slice(0, 8)
    const label = await prisma.labelDefinition.create({
      data: {
        key: `weekly_review_target_boundary_${suffix}`,
        description: '架空の target boundary テストラベル',
        currentRuleVersion: '1.0.0',
      },
    })
    const accountId = `target_boundary_${suffix}`
    const targetFrom = new Date('2026-08-01T00:00:00Z')
    const targetTo = new Date('2026-08-08T00:00:00Z')
    const beforeTarget = new Date('2026-08-07T12:00:00Z')
    const afterTarget = new Date('2026-08-08T00:00:10Z')

    try {
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
      await prisma.accountLabel.createMany({
        data: [
          {
            accountId,
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.8,
            reason: 'before target',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt: beforeTarget,
          },
          {
            accountId,
            labelDefinitionId: label.id,
            value: false,
            confidence: 0.2,
            reason: 'after target',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt: afterTarget,
          },
        ],
      })
      await prisma.accountLabelLatest.create({
        data: {
          accountId,
          labelDefinitionId: label.id,
          value: false,
          confidence: 0.2,
          reason: 'after target',
          method: 'rule',
          ruleVersion: '1.0.0',
          labeledAt: afterTarget,
        },
      })

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      const candidates = await source.listRecentCandidates(targetFrom, targetTo, 1, 'boundary-seed')
      const candidate = candidates.find((row) => row.labelDefinitionId === label.id)

      expect(candidate).toMatchObject({
        accountId,
        value: true,
        confidence: 0.8,
        reason: 'before target',
      })
      expect(candidate?.labeledAt).toEqual(beforeTarget)
    } finally {
      await prisma.accountLabelLatest.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.accountLabel.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.account.deleteMany({ where: { id: accountId } })
      await prisma.labelDefinition.deleteMany({ where: { id: label.id } })
    }
  })

  it('同一 labeledAt の履歴は id DESC の行を candidate に使う', async () => {
    const suffix = randomUUID().slice(0, 8)
    const label = await prisma.labelDefinition.create({
      data: {
        key: `weekly_review_tie_${suffix}`,
        description: '同一時刻 tie-break テストラベル',
        currentRuleVersion: '1.0.0',
      },
    })
    const accountId = `tie_${suffix}`
    const labeledAt = new Date('2026-08-07T12:00:00Z')

    try {
      await prisma.account.create({
        data: {
          id: accountId,
          screenName: accountId,
          displayName: 'Tie Account',
          followersCount: 1,
          followingCount: 1,
          tweetCount: 1,
          accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
        },
      })
      await prisma.accountLabel.createMany({
        data: [
          {
            id: `z_${suffix}`,
            accountId,
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.9,
            reason: 'id desc winner',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt,
          },
          {
            id: `a_${suffix}`,
            accountId,
            labelDefinitionId: label.id,
            value: false,
            confidence: 0.1,
            reason: 'latest table loser',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt,
          },
        ],
      })
      await prisma.accountLabelLatest.create({
        data: {
          accountId,
          labelDefinitionId: label.id,
          value: false,
          confidence: 0.1,
          reason: 'latest table loser',
          method: 'rule',
          ruleVersion: '1.0.0',
          labeledAt,
        },
      })

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      const candidates = await source.listRecentCandidates(
        new Date('2026-08-01T00:00:00Z'),
        new Date('2026-08-08T00:00:00Z'),
        1,
        'tie-seed',
      )
      const candidate = candidates.find((row) => row.labelDefinitionId === label.id)

      expect(candidate).toMatchObject({
        accountId,
        value: true,
        confidence: 0.9,
        reason: 'id desc winner',
      })
    } finally {
      await prisma.accountLabelLatest.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.accountLabel.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.account.deleteMany({ where: { id: accountId } })
      await prisma.labelDefinition.deleteMany({ where: { id: label.id } })
    }
  })

  it('listPopulationCounts は sample frame と同じ DISTINCT ON キーで重複排除した件数を返す', async () => {
    const suffix = randomUUID().slice(0, 8)
    const label = await prisma.labelDefinition.create({
      data: {
        key: `weekly_review_population_${suffix}`,
        description: '架空の population count テストラベル',
        currentRuleVersion: '1.0.0',
      },
    })
    const targetFrom = new Date('2026-08-01T00:00:00Z')
    const targetTo = new Date('2026-08-08T00:00:00Z')
    const accountIds = Array.from({ length: 3 }, (_, index) => `population_${index}_${suffix}`)

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
      // 同一アカウントの relabel 履歴が複数残っていても、
      // DISTINCT ON (accountId, labelDefinitionId) により重複カウントされないことを確認する。
      await prisma.accountLabel.createMany({
        data: [
          {
            accountId: accountIds[0],
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.2,
            reason: 'synthetic stale positive',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt: new Date('2026-08-02T00:00:00Z'),
          },
          {
            accountId: accountIds[0],
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.9,
            reason: 'synthetic latest positive',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt: new Date('2026-08-03T00:00:00Z'),
          },
          {
            accountId: accountIds[1],
            labelDefinitionId: label.id,
            value: true,
            confidence: 0.8,
            reason: 'synthetic positive',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt: new Date('2026-08-04T00:00:00Z'),
          },
          {
            accountId: accountIds[2],
            labelDefinitionId: label.id,
            value: false,
            confidence: 0.1,
            reason: 'synthetic negative',
            method: 'rule',
            ruleVersion: '1.0.0',
            labeledAt: new Date('2026-08-05T00:00:00Z'),
          },
        ],
      })

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      const populationCounts = await source.listPopulationCounts(targetFrom, targetTo)
      const trueCountRow = populationCounts.find(
        (row) => row.labelDefinitionId === label.id && row.value,
      )
      const falseCountRow = populationCounts.find(
        (row) => row.labelDefinitionId === label.id && !row.value,
      )

      expect(trueCountRow?.count).toBe(2)
      expect(falseCountRow?.count).toBe(1)
    } finally {
      await prisma.accountLabelLatest.deleteMany({ where: { labelDefinitionId: label.id } })
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
      await prisma.accountLabel.deleteMany({ where: { accountId } })
      await prisma.reviewFinding.deleteMany({ where: { fingerprint: findingFingerprint } })
      await prisma.labelMetricSnapshot.deleteMany({ where: { labelDefinitionId: label.id } })
      await prisma.account.deleteMany({ where: { id: accountId } })
      await prisma.labelDefinition.deleteMany({ where: { id: label.id } })
    }
  })
})
