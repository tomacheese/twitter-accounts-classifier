import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createSyntheticId, createSyntheticSerialId } from 'id-boundary'
import { Prisma } from '../generated/prisma'
import { getPrismaClient } from '../db/client'
import { recordAccountLabelsBulkForAccounts } from '../db/label-repository'
import { loadWeeklyReviewPlanningData } from './review-plan-data'
import { PrismaWeeklyReviewPlanningDataSource } from './prisma-review-plan-data-source'
import { BUCKET_COUNT, assignBucket } from './sample-bucket'

interface SyntheticClassificationRow {
  accountId: string
  labelDefinitionId: number
  value: boolean
  confidence: number
  reason: string
  method: string
  ruleVersion: string
  observedAt: Date
  evaluable: boolean
  labeledAt: Date | null
}

const prisma = getPrismaClient()

// 乱数の ID は衝突しうるため、基点からの連番で一意にする。
const ID_BASE = BigInt(createSyntheticId())
let idCounter = 0n
function newId(): string {
  idCounter += 1n
  return String(ID_BASE + idCounter)
}

async function createAccounts(accountIds: string[]): Promise<void> {
  await prisma.account.createMany({
    data: accountIds.map((accountId) => ({
      id: accountId,
      screenName: `synthetic_${accountId}`,
      displayName: 'Synthetic Account',
      followersCount: 1,
      followingCount: 1,
      tweetCount: 1,
      accountCreatedAt: new Date('2020-01-01T00:00:00Z'),
    })),
  })
  await prisma.accountCrawlState.createMany({
    data: accountIds.map((accountId) => ({ accountId })),
  })
}

async function createClassifications(data: SyntheticClassificationRow[]): Promise<void> {
  await prisma.accountClassificationLatest.createMany({ data })
}

async function cleanupLabel(labelId: number, accountIds: string[]): Promise<void> {
  await prisma.accountClassificationLatest.deleteMany({ where: { labelDefinitionId: labelId } })
  await prisma.weeklyReviewSampleBucketCount.deleteMany({ where: { labelDefinitionId: labelId } })
  await prisma.accountLabelChange.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.accountActiveLabel.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.accountLabelState.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.accountCrawlState.deleteMany({ where: { accountId: { in: accountIds } } })
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } })
  await prisma.labelRuleVersion.deleteMany({ where: { labelDefinitionId: labelId } })
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
        },
      })
      const eligibleId = newId()
      const notEvaluableId = newId()
      const noLabeledAtId = newId()
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
        },
      })
      const accountIds = Array.from({ length: 20 }, () => newId())
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
        },
      })
      const accountIds = Array.from({ length: 5 }, () => newId())
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
        },
      })
      const trueIds = Array.from({ length: 3 }, () => newId())
      const falseIds = Array.from({ length: 2 }, () => newId())
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
    const bootstrapModelKey = 'account_summary_sampling_v2'
    const legacyBuggyModelKey = 'account_summary_v2'
    const stateModelKey = 'account_summary_latest'

    afterAll(async () => {
      await prisma.readModelBootstrap.deleteMany({
        where: { modelKey: { in: [bootstrapModelKey, legacyBuggyModelKey] } },
      })
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

    it('旧 account_summary_v2 が completed でも、新 account_summary_sampling_v2 が無ければ拒否する', async () => {
      await prisma.readModelBootstrap.upsert({
        where: { modelKey: legacyBuggyModelKey },
        create: { modelKey: legacyBuggyModelKey, status: 'completed', cursor: '9999999' },
        update: { status: 'completed', cursor: '9999999' },
      })
      await prisma.readModelBootstrap.deleteMany({ where: { modelKey: bootstrapModelKey } })
      await prisma.readModelState.upsert({
        where: { modelKey: stateModelKey },
        create: { modelKey: stateModelKey, schemaVersion: 2, status: 'healthy' },
        update: { schemaVersion: 2, status: 'healthy' },
      })

      const source = new PrismaWeeklyReviewPlanningDataSource(prisma)
      await expect(source.assertSamplingReady()).rejects.toThrow()
    })
  })

  describe('weekly_review_sample_bucket parity', () => {
    it('TS の assignBucket と DB の weekly_review_sample_bucket は SHA-256 先頭 32bit 由来の bucket を返す', async () => {
      const accountIds = [
        '1234567890123456780',
        '1234567890123456817',
        '1234567890123456854',
        '1234567890123456891',
        '1234567890123456928',
      ]

      for (const accountId of accountIds) {
        const expectedBucket =
          Number.parseInt(createHash('sha256').update(accountId).digest('hex').slice(0, 8), 16) &
          (BUCKET_COUNT - 1)

        const [row] = await prisma.$queryRaw<{ bucket: number }[]>(
          Prisma.sql`SELECT weekly_review_sample_bucket(${accountId}::bigint) AS bucket`,
        )
        expect(row.bucket).toBe(expectedBucket)
        expect(assignBucket(accountId)).toBe(expectedBucket)
      }
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
    // removed (現在 false)、unevaluable (現在評価不能)、added (現在 true) の 3 通りを 1 ラベルで並べる。
    const removedId = newId()
    const unevaluableId = newId()
    const addedId = newId()
    const accountIds = [removedId, unevaluableId, addedId]
    const now = new Date('2026-08-08T00:00:00Z')
    const previous = new Date('2026-08-01T00:00:00Z')
    const triggerA = createSyntheticSerialId()
    const triggerB = triggerA + 1
    const findingFingerprint = `weekly-review-test-${suffix}`
    const label = await prisma.labelDefinition.create({
      data: {
        key: labelKey,
        description: '架空の週次レビューテストラベル',
        currentRuleVersionNo: 1,
        ruleVersions: { create: { versionNo: 1, ruleVersion: '2.0.0' } },
      },
    })

    try {
      await createAccounts(accountIds)
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
          primaryScopeId: String(label.id),
          currentSeverity: 'medium',
          maximumSeverity: 'medium',
        },
      })
      await prisma.accountClassificationLatest.create({
        data: {
          accountId: removedId,
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
      // 現在の評価状態を、書き込み関数を通して作る。
      const writeState = async (
        accountId: string,
        result: { value: boolean; confidence: number; reason: string; evaluable?: boolean },
      ): Promise<void> => {
        await recordAccountLabelsBulkForAccounts(prisma, {
          labels: [
            {
              accountId,
              labelDefinitionId: label.id,
              result,
              method: 'rule',
              ruleVersion: '2.0.0',
            },
          ],
          expectedRevByAccountId: new Map([[accountId, 0]]),
          sourceKind: 'relabel',
        })
      }
      await writeState(removedId, { value: false, confidence: 0.7, reason: 'synthetic near miss' })
      await writeState(unevaluableId, {
        value: false,
        confidence: 0.5,
        reason: 'synthetic no samples',
        evaluable: false,
      })
      await writeState(addedId, { value: true, confidence: 0.9, reason: 'synthetic positive' })
      // 書き込み関数が作った変更履歴は期間外のため消し、期間内の履歴を明示的に用意する。
      await prisma.accountLabelChange.deleteMany({ where: { accountId: { in: accountIds } } })
      await prisma.accountLabelChange.createMany({
        data: [
          {
            accountId: removedId,
            labelDefinitionId: label.id,
            changeType: 'added',
            previousValue: null,
            newValue: true,
            changedAt: previous,
          },
          {
            accountId: removedId,
            labelDefinitionId: label.id,
            changeType: 'removed',
            previousValue: true,
            newValue: false,
            previousConfidence: 0.95,
            previousReason: 'matched keyword',
            changedAt: now,
          },
          {
            accountId: unevaluableId,
            labelDefinitionId: label.id,
            changeType: 'unevaluable',
            previousValue: true,
            newValue: null,
            previousConfidence: 0.95,
            previousReason: 'matched keyword',
            changedAt: now,
          },
          {
            accountId: addedId,
            labelDefinitionId: label.id,
            changeType: 'added',
            previousValue: null,
            newValue: true,
            newConfidence: 0.9,
            newReason: 'synthetic positive',
            changedAt: now,
          },
        ],
      })

      const data = await loadWeeklyReviewPlanningData(
        new PrismaWeeklyReviewPlanningDataSource(prisma),
        { targetFrom: previous, targetTo: now, candidatePoolSize: 20, seed: 'integration-seed' },
      )
      const plannedLabel = data.labels.find((item) => item.id === label.id)
      const candidateOf = (accountId: string) =>
        data.candidates.find(
          (item) => item.labelDefinitionId === label.id && item.accountId === accountId,
        )

      expect(plannedLabel).toMatchObject({
        currentRuleVersion: '2.0.0',
        trueCount: 2,
        totalCount: 10,
        activeFindingCount: 1,
        recentChangeCount: 4,
        latestMetrics: { prevalence: 0.2, coverage: 0.8, staleRatio: 0.1 },
        previousMetrics: { prevalence: 0.1, coverage: 0.95, staleRatio: 0 },
      })
      // ACL の行を持つ account は baseline の値に変更種別が足される。
      expect(candidateOf(removedId)).toMatchObject({
        value: false,
        confidence: 0.7,
        changeType: 'removed',
      })
      // 現在 false でも評価不能でもない true の行は AccountActiveLabel の値を使う。
      expect(candidateOf(addedId)).toMatchObject({
        value: true,
        confidence: 0.9,
        reason: 'synthetic positive',
        ruleVersion: '2.0.0',
        evaluable: true,
        changeType: 'added',
      })
      // 評価不能は行が無いため、変更の履歴から補い、評価不能として扱う。
      expect(candidateOf(unevaluableId)).toMatchObject({
        value: false,
        confidence: 0.5,
        reason: 'not currently true (unevaluable); previous reason: matched keyword',
        ruleVersion: '2.0.0',
        evaluable: false,
        changeType: 'unevaluable',
      })
    } finally {
      await prisma.reviewFinding.deleteMany({ where: { fingerprint: findingFingerprint } })
      await prisma.labelMetricSnapshot.deleteMany({ where: { labelDefinitionId: label.id } })
      await cleanupLabel(label.id, accountIds)
    }
  })

  describe('listChangeCandidates', () => {
    it('期間内に最後に変化したラベルだけを、現在の状態と合わせて 1 行ずつ返す', async () => {
      const suffix = randomUUID().slice(0, 8)
      const accountId = newId()
      const from = new Date('2026-08-01T00:00:00Z')
      const to = new Date('2026-08-08T00:00:00Z')
      const label = await prisma.labelDefinition.create({
        data: {
          key: `weekly_review_change_${suffix}`,
          description: '架空の変更候補テストラベル',
          currentRuleVersionNo: 1,
          ruleVersions: { create: { versionNo: 1, ruleVersion: '1.0.0' } },
        },
      })
      try {
        await createAccounts([accountId])
        await prisma.accountLabelChange.createMany({
          data: [
            {
              accountId,
              labelDefinitionId: label.id,
              changeType: 'added',
              newValue: true,
              changedAt: new Date('2026-08-02T00:00:00Z'),
            },
            {
              accountId,
              labelDefinitionId: label.id,
              changeType: 'removed',
              previousValue: true,
              newValue: false,
              changedAt: new Date('2026-08-05T00:00:00Z'),
            },
            {
              accountId,
              labelDefinitionId: label.id,
              changeType: 'added',
              newValue: true,
              // 期間外の変化は無視される。
              changedAt: new Date('2026-08-20T00:00:00Z'),
            },
          ],
        })

        const rows = await new PrismaWeeklyReviewPlanningDataSource(prisma).listChangeCandidates(
          from,
          to,
          10,
        )
        const own = rows.filter((row) => row.labelDefinitionId === label.id)

        expect(own).toHaveLength(1)
        expect(own[0]).toMatchObject({ accountId, changeType: 'removed', value: false })
      } finally {
        await cleanupLabel(label.id, [accountId])
      }
    })
  })
})
