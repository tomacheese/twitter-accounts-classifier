import { Prisma, type PrismaClient } from '../generated/prisma'
import type {
  PlanningAggregateRow,
  PlanningCandidateRow,
  PlanningCountRow,
  PlanningDefinitionRow,
  PlanningSnapshotRow,
  WeeklyReviewPlanningDataSource,
} from './review-plan-data'

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
    return this.prisma.$queryRaw<PlanningCandidateRow[]>(Prisma.sql`
      SELECT
        recent."accountId",
        definition.id AS "labelDefinitionId",
        definition.key AS "labelKey",
        recent.value,
        recent.confidence,
        recent.reason,
        recent."ruleVersion",
        recent."labeledAt"
      FROM "LabelDefinition" definition
      CROSS JOIN LATERAL (
        SELECT
          ranked."accountId",
          ranked.value,
          ranked.confidence,
          ranked.reason,
          ranked."ruleVersion",
          ranked."labeledAt"
        FROM (
          SELECT
            bounded."accountId",
            bounded.value,
            bounded.confidence,
            bounded.reason,
            bounded."ruleVersion",
            bounded."labeledAt",
            row_number() OVER (
              PARTITION BY bounded.value
              ORDER BY md5(bounded."accountId" || ':' || definition.id || ':' || ${seed}), bounded.id DESC
            ) AS stratum_rank
          FROM (
            SELECT
              label."accountId",
              label.value,
              label.confidence,
              label.reason,
              label."ruleVersion",
              label."labeledAt",
              label.id
            FROM "AccountLabel" label
            WHERE label."labelDefinitionId" = definition.id
              AND label."labeledAt" >= ${targetFrom}
              AND label."labeledAt" <= ${targetTo}
            ORDER BY label."labeledAt" DESC, label.id DESC
            LIMIT ${poolSize * 10}
          ) bounded
        ) ranked
        WHERE ranked.stratum_rank <= ${poolSize}
      ) recent
    `)
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
        recent_change."changeType"
      FROM (
        SELECT
          change."accountId",
          change."labelDefinitionId",
          change."changeType",
          change."changedAt",
          row_number() OVER (
            PARTITION BY change."accountId", change."labelDefinitionId"
            ORDER BY change."changedAt" DESC, change.id DESC
          ) AS rank
        FROM "AccountLabelChange" change
        WHERE change."changedAt" >= ${targetFrom}
          AND change."changedAt" <= ${targetTo}
      ) recent_change
      JOIN "AccountLabelLatest" latest
        ON latest."accountId" = recent_change."accountId"
       AND latest."labelDefinitionId" = recent_change."labelDefinitionId"
      JOIN "LabelDefinition" definition ON definition.id = latest."labelDefinitionId"
      WHERE recent_change.rank = 1
      ORDER BY recent_change."changedAt" DESC
      LIMIT ${limit}
    `)
  }
}
