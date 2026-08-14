import { Prisma, type PrismaClient } from '../generated/prisma'
import { runWithConcurrencyLimit } from '../utils/concurrency-limit'
import type {
  PlanningAggregateRow,
  PlanningCandidateRow,
  PlanningCountRow,
  PlanningDefinitionRow,
  PlanningPopulationCountRow,
  PlanningSnapshotRow,
  WeeklyReviewPlanningDataSource,
} from './review-plan-data'

const RECENT_CANDIDATE_QUERY_CONCURRENCY = 2
const POPULATION_COUNT_QUERY_CONCURRENCY = 2

type RecentCandidateByValueRow = Omit<
  PlanningCandidateRow,
  'labelDefinitionId' | 'labelKey' | 'changeType'
>
type PopulationCountByValueRow = Pick<PlanningPopulationCountRow, 'value' | 'count'>

export class PrismaWeeklyReviewPlanningDataSource implements WeeklyReviewPlanningDataSource {
  public constructor(private readonly prisma: PrismaClient) {}

  public async listDefinitions(): Promise<PlanningDefinitionRow[]> {
    return this.prisma.labelDefinition.findMany({
      select: { id: true, key: true, currentRuleVersion: true },
      orderBy: { key: 'asc' },
    })
  }

  public async listAggregates(): Promise<PlanningAggregateRow[]> {
    return this.prisma.labelAggregate.findMany({
      select: { labelDefinitionId: true, trueCount: true, totalCount: true },
    })
  }

  public async listSnapshots(targetTo: Date): Promise<PlanningSnapshotRow[]> {
    return this.prisma.$queryRaw<PlanningSnapshotRow[]>(Prisma.sql`
      SELECT
        ranked."labelDefinitionId",
        ranked."observedAt",
        ranked.prevalence,
        ranked.coverage,
        ranked."staleRatio"
      FROM (
        SELECT
          snapshot."labelDefinitionId",
          snapshot."observedAt",
          snapshot.prevalence,
          snapshot.coverage,
          snapshot."staleRatio",
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

  public async listRecentCandidates(
    targetFrom: Date,
    targetTo: Date,
    poolSize: number,
    seed: string,
  ): Promise<PlanningCandidateRow[]> {
    const definitions = await this.prisma.labelDefinition.findMany({
      select: { id: true, key: true },
      orderBy: { id: 'asc' },
    })
    const rowsByDefinition: PlanningCandidateRow[][] = Array.from(
      { length: definitions.length },
      () => [],
    )

    await runWithConcurrencyLimit(
      definitions,
      RECENT_CANDIDATE_QUERY_CONCURRENCY,
      async (definition, index) => {
        const rows = await this.prisma.$queryRaw<RecentCandidateByValueRow[]>(Prisma.sql`
          WITH windowed AS MATERIALIZED (
            SELECT
              label.id,
              label."accountId",
              label.value,
              label."labeledAt"
            FROM "AccountLabel" label
            WHERE label."labelDefinitionId" = ${definition.id}
              AND label."labeledAt" >= ${targetFrom}
              AND label."labeledAt" <= ${targetTo}
            ORDER BY label."labeledAt" DESC, label.id DESC
          ),
          deduped AS MATERIALIZED (
            SELECT DISTINCT ON (windowed."accountId")
              windowed.id,
              windowed."accountId",
              windowed.value,
              windowed."labeledAt"
            FROM windowed
            ORDER BY windowed."accountId", windowed."labeledAt" DESC, windowed.id DESC
          ),
          sampled AS (
            (
              SELECT deduped.id, deduped."accountId", deduped.value
              FROM deduped
              WHERE deduped.value = true
              ORDER BY md5(deduped."accountId" || ':' || ${definition.id} || ':' || ${seed})
              LIMIT ${poolSize}
            )
            UNION ALL
            (
              SELECT deduped.id, deduped."accountId", deduped.value
              FROM deduped
              WHERE deduped.value = false
              ORDER BY md5(deduped."accountId" || ':' || ${definition.id} || ':' || ${seed})
              LIMIT ${poolSize}
            )
          )
          SELECT
            sampled."accountId",
            sampled.value,
            label.confidence,
            label.reason,
            label."ruleVersion",
            label."labeledAt",
            label.evaluable
          FROM sampled
          JOIN "AccountLabel" label ON label.id = sampled.id
        `)
        rowsByDefinition[index] = rows.map((row) => ({
          ...row,
          labelDefinitionId: definition.id,
          labelKey: definition.key,
        }))
      },
    )

    return rowsByDefinition.flat()
  }

  /**
   * `targetFrom`〜`targetTo` の期間内に labeled された、ラベル×value ごとのアカウント数
   * (relabel 履歴の行数ではなく account 単位の重複排除後) を返す。
   * `listRecentCandidates` と同じ targetTo 時点の最新1件を母集団とし、`evaluable` でも絞り込む。
   * ラベル単位に分割したうえで期間 window を先に materialize し、その小さい集合だけを
   * account 単位に重複排除する。time-first partial covering index は raw migration で管理する。
   */
  public async listPopulationCounts(
    targetFrom: Date,
    targetTo: Date,
  ): Promise<PlanningPopulationCountRow[]> {
    const definitions = await this.prisma.labelDefinition.findMany({
      select: { id: true },
      orderBy: { id: 'asc' },
    })
    const rowsByDefinition: PlanningPopulationCountRow[][] = Array.from(
      { length: definitions.length },
      () => [],
    )

    await runWithConcurrencyLimit(
      definitions,
      POPULATION_COUNT_QUERY_CONCURRENCY,
      async (definition, index) => {
        const rows = await this.prisma.$queryRaw<PopulationCountByValueRow[]>(Prisma.sql`
          WITH windowed AS MATERIALIZED (
            SELECT
              label."accountId",
              label.value,
              label."labeledAt",
              label.id
            FROM "AccountLabel" label
            WHERE label."labelDefinitionId" = ${definition.id}
              AND label."labeledAt" >= ${targetFrom}
              AND label."labeledAt" <= ${targetTo}
              AND label.evaluable
            ORDER BY label."labeledAt" DESC, label.id DESC
          )
          SELECT deduped.value, COUNT(*)::int AS count
          FROM (
            SELECT DISTINCT ON (windowed."accountId")
              windowed."accountId",
              windowed.value
            FROM windowed
            ORDER BY windowed."accountId", windowed."labeledAt" DESC, windowed.id DESC
          ) deduped
          GROUP BY deduped.value
        `)
        rowsByDefinition[index] = rows.map((row) => ({
          labelDefinitionId: definition.id,
          value: row.value,
          count: row.count,
        }))
      },
    )

    return rowsByDefinition.flat()
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
        change."changeType"
      FROM "AccountLabelChange" change
      JOIN "AccountLabelLatest" latest
        ON latest."accountId" = change."accountId"
       AND latest."labelDefinitionId" = change."labelDefinitionId"
      JOIN "LabelDefinition" definition ON definition.id = latest."labelDefinitionId"
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
