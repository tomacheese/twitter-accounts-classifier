import { Prisma, type PrismaClient } from '../generated/prisma'
import {
  BUCKET_COUNT,
  OVERSAMPLE_FACTOR,
  computeBucketReadCount,
  selectBuckets,
  stableRank,
} from './sample-bucket'
import type {
  PlanningCandidateRow,
  PlanningCountRow,
  PlanningDefinitionRow,
  PlanningPopulationCountRow,
  PlanningSnapshotRow,
  WeeklyReviewPlanningDataSource,
} from './review-plan-data'

/**
 * sampling bootstrap の schema key。readiness gate はこの bootstrap の完了を要求する。
 * 旧 `account_summary_v2` は再利用しない。PR #281 のバグ入り実装が一時的にでも
 * 稼働した環境ではその modelKey の下に不正な cursor が残っている可能性があるため、
 * readiness 判定はその値を無視し、無関係な新しい modelKey だけを見る。
 */
const ACCOUNT_SUMMARY_BOOTSTRAP_MODEL_KEY = 'account_summary_sampling_v2'
/** `AccountClassificationLatest` read model の schema key。 */
const ACCOUNT_SUMMARY_LATEST_MODEL_KEY = 'account_summary_latest'
/** readiness gate が要求する最小 schemaVersion。 */
const ACCOUNT_SUMMARY_LATEST_MIN_SCHEMA_VERSION = 2

type BaselineCandidateByValueRow = Omit<
  PlanningCandidateRow,
  'labelDefinitionId' | 'labelKey' | 'changeType'
>

interface BaselineCandidateTask {
  definitionId: string
  labelKey: string
  value: boolean
  populationCount: number
}

export class PrismaWeeklyReviewPlanningDataSource implements WeeklyReviewPlanningDataSource {
  public constructor(private readonly prisma: PrismaClient | Prisma.TransactionClient) {}

  public async listDefinitions(): Promise<PlanningDefinitionRow[]> {
    return this.prisma.labelDefinition.findMany({
      select: { id: true, key: true, currentRuleVersion: true },
      orderBy: { key: 'asc' },
    })
  }

  public async listSnapshots(targetTo: Date): Promise<PlanningSnapshotRow[]> {
    return this.prisma.$queryRaw<PlanningSnapshotRow[]>(Prisma.sql`
      SELECT
        ranked."labelDefinitionId",
        ranked."observedAt",
        ranked.prevalence,
        ranked.coverage,
        ranked."staleRatio",
        ranked."trueCount",
        ranked."evaluatedCount"
      FROM (
        SELECT
          snapshot."labelDefinitionId",
          snapshot."observedAt",
          snapshot.prevalence,
          snapshot.coverage,
          snapshot."staleRatio",
          snapshot."trueCount",
          snapshot."evaluatedCount",
          row_number() OVER (
            PARTITION BY snapshot."labelDefinitionId"
            ORDER BY snapshot."observedAt" DESC, snapshot.id DESC
          ) AS rank
        FROM "LabelMetricSnapshot" snapshot
        WHERE snapshot."observedAt" <= ${targetTo}
      ) ranked
      WHERE ranked.rank <= 2
    `)
  }

  public async listActiveFindingCounts(): Promise<PlanningCountRow[]> {
    const rows = await this.prisma.reviewFinding.groupBy({
      by: ['primaryScopeId'],
      where: {
        primaryScopeType: 'label',
        status: { in: ['active', 'recurring'] },
      },
      _count: { _all: true },
    })
    return rows.map((row) => ({ labelDefinitionId: row.primaryScopeId, count: row._count._all }))
  }

  public async listRecentChangeCounts(
    targetFrom: Date,
    targetTo: Date,
  ): Promise<PlanningCountRow[]> {
    const rows = await this.prisma.accountLabelChange.groupBy({
      by: ['labelDefinitionId'],
      where: { changedAt: { gte: targetFrom, lte: targetTo } },
      _count: { _all: true },
    })
    return rows.map((row) => ({ labelDefinitionId: row.labelDefinitionId, count: row._count._all }))
  }

  public async listPopulationCounts(): Promise<PlanningPopulationCountRow[]> {
    const rows = await this.prisma.weeklyReviewSampleBucketCount.groupBy({
      by: ['labelDefinitionId', 'value'],
      _sum: { count: true },
    })
    return rows.map((row) => ({
      labelDefinitionId: row.labelDefinitionId,
      value: row.value,
      count: row._sum.count ?? 0,
    }))
  }

  public async listBaselineCandidates(
    poolSize: number,
    seed: string,
  ): Promise<PlanningCandidateRow[]> {
    const [definitions, populationCounts] = await Promise.all([
      this.prisma.labelDefinition.findMany({
        select: { id: true, key: true },
        orderBy: { id: 'asc' },
      }),
      this.listPopulationCounts(),
    ])
    const populationByKey = new Map(
      populationCounts.map((row) => [`${row.labelDefinitionId}:${row.value}`, row.count]),
    )

    const tasks: BaselineCandidateTask[] = []
    for (const definition of definitions) {
      for (const value of [true, false]) {
        const populationCount = populationByKey.get(`${definition.id}:${value}`) ?? 0
        if (populationCount <= 0) continue
        tasks.push({
          definitionId: definition.id,
          labelKey: definition.key,
          value,
          populationCount,
        })
      }
    }

    const rowsByTask: PlanningCandidateRow[][] = []

    // REPEATABLE READ の interactive transaction は単一 connection 上で実質直列にしか
    // 実行されないため、並行実行しても短縮効果がなく複雑さだけが増える。
    for (const task of tasks) {
      const bucketReadCount = computeBucketReadCount(
        task.populationCount,
        poolSize,
        OVERSAMPLE_FACTOR,
      )
      const buckets =
        bucketReadCount >= BUCKET_COUNT
          ? undefined
          : selectBuckets(seed, task.definitionId, task.value, bucketReadCount)
      const rows = await this.prisma.$queryRaw<BaselineCandidateByValueRow[]>(Prisma.sql`
        SELECT
          classification."accountId",
          classification.value,
          classification.confidence,
          classification.reason,
          classification."ruleVersion",
          classification."labeledAt",
          classification.evaluable,
          account."recentTweetsFetchStatus",
          account."lastRecentTweetsAttemptedAt",
          account."lastRecentTweetsFetchedAt"
        FROM "AccountClassificationLatest" classification
        JOIN "Account" account ON account.id = classification."accountId"
        WHERE classification."labelDefinitionId" = ${task.definitionId}
          AND classification.value = ${task.value}
          AND classification.evaluable = true
          AND classification."labeledAt" IS NOT NULL
          ${
            buckets === undefined
              ? Prisma.empty
              : Prisma.sql`AND weekly_review_sample_bucket(classification."accountId") = ANY(${buckets}::int[])`
          }
      `)
      const ranked = rows.toSorted((a, b) =>
        stableRank(seed, task.definitionId, String(task.value), a.accountId).localeCompare(
          stableRank(seed, task.definitionId, String(task.value), b.accountId),
        ),
      )
      rowsByTask.push(
        ranked.slice(0, poolSize).map((row) => ({
          ...row,
          labelDefinitionId: task.definitionId,
          labelKey: task.labelKey,
        })),
      )
    }

    return rowsByTask.flat()
  }

  public async assertSamplingReady(): Promise<void> {
    const [bootstrap, state] = await Promise.all([
      this.prisma.readModelBootstrap.findUnique({
        where: { modelKey: ACCOUNT_SUMMARY_BOOTSTRAP_MODEL_KEY },
      }),
      this.prisma.readModelState.findUnique({
        where: { modelKey: ACCOUNT_SUMMARY_LATEST_MODEL_KEY },
      }),
    ])
    if (bootstrap?.status !== 'completed') {
      throw new Error(
        `weekly review sampling is not ready: ${ACCOUNT_SUMMARY_BOOTSTRAP_MODEL_KEY} bootstrap is not completed`,
      )
    }
    if (
      !state ||
      state.schemaVersion < ACCOUNT_SUMMARY_LATEST_MIN_SCHEMA_VERSION ||
      state.status !== 'healthy'
    ) {
      throw new Error(
        `weekly review sampling is not ready: ${ACCOUNT_SUMMARY_LATEST_MODEL_KEY} read model is not healthy`,
      )
    }
  }

  public async readSnapshotAt(): Promise<Date> {
    const [row] = await this.prisma.$queryRaw<{ now: Date }[]>(Prisma.sql`SELECT now()`)
    return row.now
  }

  public async listChangeCandidates(
    targetFrom: Date,
    targetTo: Date,
    limit: number,
  ): Promise<PlanningCandidateRow[]> {
    return this.prisma.$queryRaw<PlanningCandidateRow[]>(Prisma.sql`
      SELECT
        latest."accountId",
        latest."labelDefinitionId",
        definition.key AS "labelKey",
        latest.value,
        latest.confidence,
        latest.reason,
        latest."ruleVersion",
        latest."labeledAt",
        latest.evaluable,
        account."recentTweetsFetchStatus",
        account."lastRecentTweetsAttemptedAt",
        account."lastRecentTweetsFetchedAt",
        change."changeType"
      FROM "AccountLabelChange" change
      JOIN "AccountLabelLatest" latest
        ON latest."accountId" = change."accountId"
       AND latest."labelDefinitionId" = change."labelDefinitionId"
      JOIN "LabelDefinition" definition ON definition.id = latest."labelDefinitionId"
      JOIN "Account" account ON account.id = latest."accountId"
      WHERE change."changedAt" >= ${targetFrom}
        AND change."changedAt" <= ${targetTo}
        AND NOT EXISTS (
          SELECT 1
          FROM "AccountLabelChange" newer
          WHERE newer."accountId" = change."accountId"
            AND newer."labelDefinitionId" = change."labelDefinitionId"
            AND newer."changedAt" > change."changedAt"
            AND newer."changedAt" <= ${targetTo}
        )
      ORDER BY change."changedAt" DESC, change.id DESC
      LIMIT ${limit}
    `)
  }
}
