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
  definitionId: number
  labelKey: string
  value: boolean
  populationCount: number
}

export class PrismaWeeklyReviewPlanningDataSource implements WeeklyReviewPlanningDataSource {
  public constructor(private readonly prisma: PrismaClient | Prisma.TransactionClient) {}

  public async listDefinitions(): Promise<PlanningDefinitionRow[]> {
    const definitions = await this.prisma.labelDefinition.findMany({
      where: { retiredAt: null },
      select: {
        id: true,
        key: true,
        currentRuleVersionNo: true,
        ruleVersions: { select: { versionNo: true, ruleVersion: true } },
      },
      orderBy: { key: 'asc' },
    })
    return definitions.map((definition) => ({
      id: definition.id,
      key: definition.key,
      currentRuleVersion:
        definition.ruleVersions.find(
          (version) => version.versionNo === definition.currentRuleVersionNo,
        )?.ruleVersion ?? null,
    }))
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
    return rows.map((row) => ({
      labelDefinitionId: Number(row.primaryScopeId),
      count: row._count._all,
    }))
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
        where: { retiredAt: null },
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
          classification."accountId"::text AS "accountId",
          classification.value,
          classification.confidence,
          classification.reason,
          classification."ruleVersion",
          classification."labeledAt",
          classification.evaluable,
          crawl."recentTweetsFetchStatus",
          crawl."lastRecentTweetsAttemptedAt",
          crawl."lastRecentTweetsFetchedAt"
        FROM "AccountClassificationLatest" classification
        JOIN "AccountCrawlState" crawl ON crawl."accountId" = classification."accountId"
        WHERE classification."labelDefinitionId" = ${task.definitionId}::smallint
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
        stableRank(seed, String(task.definitionId), String(task.value), a.accountId).localeCompare(
          stableRank(seed, String(task.definitionId), String(task.value), b.accountId),
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

  /**
   * 期間内に最後に変化したラベルごとに、現在の評価状態を持つ candidate を返す。
   * true の行は AccountActiveLabel から、それ以外は AccountLabelState の符号から (正は false、負は評価不能) 判定する。
   * false と評価不能の行は reason と confidence を持たないため、変化の記録から補い、無ければ中立値にする。
   * LEFT JOIN のため、現在 true でないラベルの変化 (removed と unevaluable) も落とさない。
   */
  public async listChangeCandidates(
    targetFrom: Date,
    targetTo: Date,
    limit: number,
  ): Promise<PlanningCandidateRow[]> {
    return this.prisma.$queryRaw<PlanningCandidateRow[]>(Prisma.sql`
      SELECT
        change."accountId"::text AS "accountId",
        change."labelDefinitionId",
        definition.key AS "labelKey",
        (active."accountId" IS NOT NULL) AS value,
        COALESCE(active.confidence, change."newConfidence", 0.5) AS confidence,
        COALESCE(
          active.reason,
          change."newReason",
          'not currently true (' || change."changeType" || '); previous reason: '
            || COALESCE(change."previousReason", 'n/a')
        ) AS reason,
        COALESCE(rule_version."ruleVersion", '') AS "ruleVersion",
        COALESCE(active."labeledAt", state."evaluatedAt", change."changedAt") AS "labeledAt",
        (active."accountId" IS NOT NULL OR COALESCE(state.versions[change."labelDefinitionId"], 0) > 0)
          AS evaluable,
        crawl."recentTweetsFetchStatus",
        crawl."lastRecentTweetsAttemptedAt",
        crawl."lastRecentTweetsFetchedAt",
        change."changeType"::text AS "changeType"
      FROM "AccountLabelChange" change
      LEFT JOIN "AccountActiveLabel" active
        ON active."accountId" = change."accountId"
       AND active."labelDefinitionId" = change."labelDefinitionId"
      LEFT JOIN "AccountLabelState" state ON state."accountId" = change."accountId"
      LEFT JOIN "LabelRuleVersion" rule_version
        ON rule_version."labelDefinitionId" = change."labelDefinitionId"
       AND rule_version."versionNo" = abs(COALESCE(
             active."ruleVersionNo", state.versions[change."labelDefinitionId"], 0))
      JOIN "LabelDefinition" definition ON definition.id = change."labelDefinitionId"
      JOIN "AccountCrawlState" crawl ON crawl."accountId" = change."accountId"
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
