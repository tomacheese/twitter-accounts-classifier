import { Prisma, type PrismaClient } from '../generated/prisma'
import { Logger } from '@book000/node-utils'

const logger = Logger.configure('analyzer:label-metric-snapshot')

/** LabelMetricSnapshot.completeness の値。 */
export type SnapshotCompleteness = 'complete' | 'partial' | 'unknown'

/**
 * generateLabelMetricSnapshots の入力。
 */
export interface GenerateLabelMetricSnapshotsInput {
  /** 集計対象の CrawlRun ID。 */
  crawlRunId: string
  /** 集計対象の CrawlRun の終了状態。 */
  crawlRunStatus: string
  /** 集計の基準時刻。この時刻時点のラベル値を集計する。 */
  sourceWatermarkAt: Date
  /** 適用したポリシーの content hash。 */
  policyHash: string
  /** 集計を行った analyzer のバージョン。 */
  analyzerVersion: string
  /** 紐づく AnalysisRun の ID。 */
  analysisRunId?: string
}

/**
 * 部分的にしかアカウントを巡回できなかった run の集計値をそのまま前回と比較すると、
 * 巡回できなかった分の減少をラベル付けの劣化として誤検出する。
 * 検出器がそれを避けられるよう、run の終了状態を completeness へ引き継ぐ。
 * @param crawlRunStatus - CrawlRun.status の値
 * @returns snapshot の completeness
 */
export function deriveCompletenessFromRunStatus(crawlRunStatus: string): SnapshotCompleteness {
  if (crawlRunStatus === 'success') return 'complete'
  if (crawlRunStatus === 'partial' || crawlRunStatus === 'failed' || crawlRunStatus === 'timeout') {
    return 'partial'
  }
  return 'unknown'
}

/** 1 Label 分の集計結果。 */
interface LabelAggregate {
  evaluatedCount: number
  trueCount: number
  trueConfidenceAverage: number | undefined
  falseConfidenceAverage: number | undefined
  confidenceBuckets: Record<string, number>
  reasonDistribution: Record<string, number>
  ruleVersionDistribution: Record<string, number>
}

/** 集計クエリが返す 1 グループ分の行。 */
interface LabelAggregateRow {
  value: boolean
  reason: string
  ruleVersion: string
  confidenceBucket: number
  count: bigint
  confidenceSum: number
}

const CONFIDENCE_BUCKET_COUNT = 10

/**
 * @param bucket - 0 から 9 までのバケット番号
 * @returns confidenceBuckets のキー
 */
function formatConfidenceBucketKey(bucket: number): string {
  const lower = bucket / CONFIDENCE_BUCKET_COUNT
  const upper = (bucket + 1) / CONFIDENCE_BUCKET_COUNT
  return `${lower.toFixed(1)}-${upper.toFixed(1)}`
}

/**
 * AccountLabelLatest は常に現在値しか持たないため、そこから集計すると
 * 対象 run の後に走った crawl や relabel の結果まで混ざり、
 * run ごとの snapshot として baseline 比較に使えなくなる。
 * 変更のたびに履歴が積まれる AccountLabel から基準時刻時点の値を復元して集計する。
 * @param prisma - Prisma クライアント
 * @param labelDefinitionId - 集計対象の LabelDefinition
 * @param sourceWatermarkAt - 集計の基準時刻
 * @returns 基準時刻時点のラベル分布
 */
async function aggregateLabelAtWatermark(
  prisma: PrismaClient,
  labelDefinitionId: string,
  sourceWatermarkAt: Date,
): Promise<LabelAggregate> {
  const rows = await prisma.$queryRaw<LabelAggregateRow[]>`
    SELECT
      latest."value",
      latest."reason",
      latest."ruleVersion",
      LEAST(FLOOR(latest."confidence" * ${CONFIDENCE_BUCKET_COUNT}), ${CONFIDENCE_BUCKET_COUNT - 1})::int
        AS "confidenceBucket",
      COUNT(*) AS "count",
      SUM(latest."confidence") AS "confidenceSum"
    FROM (
      SELECT DISTINCT ON ("accountId")
        "accountId", "value", "confidence", "reason", "ruleVersion"
      FROM "AccountLabel"
      WHERE "labelDefinitionId" = ${labelDefinitionId}
        AND "labeledAt" <= ${sourceWatermarkAt}
      ORDER BY "accountId", "labeledAt" DESC, "id" DESC
    ) latest
    GROUP BY 1, 2, 3, 4
  `

  const aggregate: LabelAggregate = {
    evaluatedCount: 0,
    trueCount: 0,
    trueConfidenceAverage: undefined,
    falseConfidenceAverage: undefined,
    confidenceBuckets: {},
    reasonDistribution: {},
    ruleVersionDistribution: {},
  }
  let trueConfidenceSum = 0
  let falseConfidenceSum = 0
  let falseCount = 0

  for (const row of rows) {
    const count = Number(row.count)
    aggregate.evaluatedCount += count
    if (row.value) {
      aggregate.trueCount += count
      trueConfidenceSum += row.confidenceSum
      // reason は true と判定した根拠であり、false の reason を混ぜると
      // 検出器が見る分布が「なぜ付いたか」を表さなくなる。
      aggregate.reasonDistribution[row.reason] =
        (aggregate.reasonDistribution[row.reason] ?? 0) + count
    } else {
      falseCount += count
      falseConfidenceSum += row.confidenceSum
    }
    const bucketKey = formatConfidenceBucketKey(row.confidenceBucket)
    aggregate.confidenceBuckets[bucketKey] = (aggregate.confidenceBuckets[bucketKey] ?? 0) + count
    aggregate.ruleVersionDistribution[row.ruleVersion] =
      (aggregate.ruleVersionDistribution[row.ruleVersion] ?? 0) + count
  }

  if (aggregate.trueCount > 0) {
    aggregate.trueConfidenceAverage = trueConfidenceSum / aggregate.trueCount
  }
  if (falseCount > 0) {
    aggregate.falseConfidenceAverage = falseConfidenceSum / falseCount
  }
  return aggregate
}

/**
 * @param prisma - Prisma クライアント
 * @param labelDefinitionId - 集計対象の LabelDefinition
 * @param input - 対象 crawl run と付随メタデータ
 */
async function generateOneLabelSnapshot(
  prisma: PrismaClient,
  labelDefinitionId: string,
  input: GenerateLabelMetricSnapshotsInput,
): Promise<void> {
  const aggregate = await aggregateLabelAtWatermark(
    prisma,
    labelDefinitionId,
    input.sourceWatermarkAt,
  )
  const prevalence =
    aggregate.evaluatedCount === 0 ? 0 : aggregate.trueCount / aggregate.evaluatedCount
  const completeness = deriveCompletenessFromRunStatus(input.crawlRunStatus)
  const distributions = {
    confidenceBuckets: aggregate.confidenceBuckets as Prisma.InputJsonValue,
    reasonDistribution: aggregate.reasonDistribution as Prisma.InputJsonValue,
    ruleVersionDistribution: aggregate.ruleVersionDistribution as Prisma.InputJsonValue,
  }

  await prisma.labelMetricSnapshot.upsert({
    where: {
      sourceCrawlRunId_labelDefinitionId: { sourceCrawlRunId: input.crawlRunId, labelDefinitionId },
    },
    create: {
      sourceCrawlRunId: input.crawlRunId,
      labelDefinitionId,
      observedAt: input.sourceWatermarkAt,
      sourceWatermarkAt: input.sourceWatermarkAt,
      evaluatedCount: aggregate.evaluatedCount,
      trueCount: aggregate.trueCount,
      prevalence,
      trueConfidenceAverage: aggregate.trueConfidenceAverage,
      falseConfidenceAverage: aggregate.falseConfidenceAverage,
      ...distributions,
      completeness,
      policyHash: input.policyHash,
      analyzerVersion: input.analyzerVersion,
      analysisRunId: input.analysisRunId,
    },
    update: {
      evaluatedCount: aggregate.evaluatedCount,
      trueCount: aggregate.trueCount,
      prevalence,
      trueConfidenceAverage: aggregate.trueConfidenceAverage,
      falseConfidenceAverage: aggregate.falseConfidenceAverage,
      ...distributions,
      completeness,
    },
  })
}

/** generateLabelMetricSnapshots の結果。 */
export interface GenerateLabelMetricSnapshotsResult {
  /** 集計を試みた Label 数。 */
  totalCount: number
  /** 集計に失敗した Label の ID。 */
  failedLabelDefinitionIds: string[]
}

/**
 * LabelDefinition ごとに独立して集計・checkpoint する。
 * 1 Label の失敗が他 Label の結果を巻き込まないよう、Promise.allSettled で並行実行する。
 * 失敗した Label は completeness: 'unknown' の行として記録する。
 * 行自体を欠落させると「集計されていない」のか「値が 0 件」なのか区別できなくなるため。
 * @param prisma - Prisma クライアント
 * @param input - 対象 crawl run と付随メタデータ
 * @returns 集計を試みた Label 数と失敗した Label の ID
 */
export async function generateLabelMetricSnapshots(
  prisma: PrismaClient,
  input: GenerateLabelMetricSnapshotsInput,
): Promise<GenerateLabelMetricSnapshotsResult> {
  const labelDefinitions = await prisma.labelDefinition.findMany({ select: { id: true } })

  const results = await Promise.allSettled(
    labelDefinitions.map((label) => generateOneLabelSnapshot(prisma, label.id, input)),
  )

  const failedLabelDefinitionIds: string[] = []
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      const labelDefinitionId = labelDefinitions[index]?.id
      if (!labelDefinitionId) continue
      failedLabelDefinitionIds.push(labelDefinitionId)
      logger.error(
        `label metric snapshot failed for label ${labelDefinitionId}`,
        result.reason as Error,
      )
      await prisma.labelMetricSnapshot.upsert({
        where: {
          sourceCrawlRunId_labelDefinitionId: {
            sourceCrawlRunId: input.crawlRunId,
            labelDefinitionId,
          },
        },
        create: {
          sourceCrawlRunId: input.crawlRunId,
          labelDefinitionId,
          observedAt: input.sourceWatermarkAt,
          sourceWatermarkAt: input.sourceWatermarkAt,
          evaluatedCount: 0,
          trueCount: 0,
          prevalence: 0,
          completeness: 'unknown',
          policyHash: input.policyHash,
          analyzerVersion: input.analyzerVersion,
          analysisRunId: input.analysisRunId,
        },
        update: { completeness: 'unknown' },
      })
    }
  }

  return { totalCount: labelDefinitions.length, failedLabelDefinitionIds }
}

/** completeness 導出のしきい値。 */
export interface CompletenessThresholds {
  minCoverage: number
  maxStaleRatio: number
}

/**
 * coverage と staleRatio から completeness を導出する。
 * CrawlRun.status への依存を廃止し、集計自体の品質だけで判定する。
 * @param coverage - populationCount に対する evaluatedCount の割合
 * @param staleRatio - evaluatedCount に対する stale 行の割合
 * @param thresholds - completeness を分ける閾値
 * @returns snapshot の completeness
 */
export function deriveCompletenessFromCoverage(
  coverage: number,
  staleRatio: number,
  thresholds: CompletenessThresholds,
): SnapshotCompleteness {
  if (coverage < thresholds.minCoverage) return 'unknown'
  if (staleRatio > thresholds.maxStaleRatio) return 'partial'
  return 'complete'
}

/** buildLabelAggregateSnapshotSet の入力。 */
export interface BuildLabelAggregateSnapshotSetInput {
  /** この build を確定させた WorkItem の id。snapshot set の識別子。 */
  triggerWorkItemId: string
  /** この build の契機となった CrawlRun 等の ID (付随メタデータ)。 */
  sourceCrawlRunId?: string
  policyHash: string
  analyzerVersion: string
  thresholds: CompletenessThresholds
  analysisRunId?: string
  /**
   * freshness 分類 (current/delayed/stale) のしきい値。ハードコードせず、
   * 呼び出し元 (processLabelAggregateRefresh) が適用中の
   * `read_model_freshness` policy ルールから算出して渡す必須パラメータとする。
   */
  freshnessThresholdsMs: { delayedAfterMs: number; staleAfterMs: number }
}

/** buildLabelAggregateSnapshotSet の結果。 */
export interface BuildLabelAggregateSnapshotSetResult {
  triggerWorkItemId: string
  snapshotAt: Date
  /** 既存の commit 済み snapshot set を再利用した場合 true。 */
  reused: boolean
}

/** 1 (value, reason, ruleVersion, confidenceBucket) 組み合わせ分の集計行。 */
interface AggregateSnapshotRow {
  value: boolean
  reason: string
  ruleVersion: string
  confidenceBucket: number
  count: bigint
  confidenceSum: number
  currentCount: bigint
  delayedCount: bigint
  staleCount: bigint
}

/**
 * `triggerWorkItemId` に紐づく Label 数分の `LabelMetricSnapshot` を、
 * 単一の `REPEATABLE READ` トランザクション内で一括構築する。
 * commit 済みの snapshot set が既に存在する場合は再ビルドせず再利用する
 * (retry のたびに mutable な `AccountClassificationLatest` の最新状態で
 * 上書きすると、同一観測の中身が retry の前後で変質するため)。
 * @param prisma - Prisma クライアント
 * @param input - トリガー識別子と閾値
 * @returns この build の `snapshotAt` と、再利用したかどうか
 */
export async function buildLabelAggregateSnapshotSet(
  prisma: PrismaClient,
  input: BuildLabelAggregateSnapshotSetInput,
): Promise<BuildLabelAggregateSnapshotSetResult> {
  const labelDefinitions = await prisma.labelDefinition.findMany({ select: { id: true } })
  const existingCount = await prisma.labelMetricSnapshot.count({
    where: { triggerWorkItemId: input.triggerWorkItemId },
  })
  if (existingCount === labelDefinitions.length && labelDefinitions.length > 0) {
    const row = await prisma.labelMetricSnapshot.findFirst({
      where: { triggerWorkItemId: input.triggerWorkItemId },
      select: { observedAt: true },
    })
    return {
      triggerWorkItemId: input.triggerWorkItemId,
      snapshotAt: row?.observedAt ?? new Date(),
      reused: true,
    }
  }

  const freshnessThresholds = input.freshnessThresholdsMs

  const snapshotAt = await prisma.$transaction(
    async (tx) => {
      const nowRows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
      const sharedSnapshotAt = nowRows.at(0)?.now ?? new Date()

      const populationRows = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT "accountId") AS count FROM "AccountClassificationLatest"
      `
      const populationCount = Number(populationRows.at(0)?.count ?? 0)

      // freshness (current/delayed/stale) の集計を JS 側で行に対して個別に判定すると、
      // GROUP BY に observedAt の生値が必要になり、Account 数に比例して行が増える。
      // 42 Label × 210 万 Account 規模では現実的な行数に収まらないため、
      // FILTER 句で current/delayed/stale の件数自体を SQL 側で集計し、
      // GROUP BY は value/reason/ruleVersion/confidenceBucket の有限な組み合わせのみに保つ。
      const delayedAfterSeconds = freshnessThresholds.delayedAfterMs / 1000
      const staleAfterSeconds = freshnessThresholds.staleAfterMs / 1000

      await Promise.all(
        labelDefinitions.map(async (label) => {
          const rows = await tx.$queryRaw<AggregateSnapshotRow[]>`
            SELECT
              "value", "reason", "ruleVersion",
              LEAST(FLOOR("confidence" * 10), 9)::int AS "confidenceBucket",
              COUNT(*) AS "count",
              SUM("confidence") AS "confidenceSum",
              COUNT(*) FILTER (
                WHERE ${sharedSnapshotAt}::timestamptz - "observedAt" <= make_interval(secs => ${delayedAfterSeconds})
              ) AS "currentCount",
              COUNT(*) FILTER (
                WHERE ${sharedSnapshotAt}::timestamptz - "observedAt" > make_interval(secs => ${delayedAfterSeconds})
                  AND ${sharedSnapshotAt}::timestamptz - "observedAt" <= make_interval(secs => ${staleAfterSeconds})
              ) AS "delayedCount",
              COUNT(*) FILTER (
                WHERE ${sharedSnapshotAt}::timestamptz - "observedAt" > make_interval(secs => ${staleAfterSeconds})
              ) AS "staleCount"
            FROM "AccountClassificationLatest"
            WHERE "labelDefinitionId" = ${label.id}
            GROUP BY 1, 2, 3, 4
          `

          let evaluatedCount = 0
          let trueCount = 0
          let trueConfidenceSum = 0
          let falseConfidenceSum = 0
          let falseCount = 0
          let currentCount = 0
          let delayedCount = 0
          let staleCount = 0
          const confidenceBuckets: Record<string, number> = {}
          const reasonDistribution: Record<string, number> = {}
          const ruleVersionDistribution: Record<string, number> = {}
          for (const row of rows) {
            const count = Number(row.count)
            evaluatedCount += count
            if (row.value) {
              trueCount += count
              trueConfidenceSum += row.confidenceSum
              reasonDistribution[row.reason] = (reasonDistribution[row.reason] ?? 0) + count
            } else {
              falseCount += count
              falseConfidenceSum += row.confidenceSum
            }
            const bucketKey = formatConfidenceBucketKey(row.confidenceBucket)
            confidenceBuckets[bucketKey] = (confidenceBuckets[bucketKey] ?? 0) + count
            ruleVersionDistribution[row.ruleVersion] =
              (ruleVersionDistribution[row.ruleVersion] ?? 0) + count

            currentCount += Number(row.currentCount)
            delayedCount += Number(row.delayedCount)
            staleCount += Number(row.staleCount)
          }

          const unknownCount = Math.max(populationCount - evaluatedCount, 0)
          const coverage = populationCount === 0 ? 0 : evaluatedCount / populationCount
          const staleRatio = evaluatedCount === 0 ? 0 : staleCount / evaluatedCount
          const prevalence = evaluatedCount === 0 ? 0 : trueCount / evaluatedCount
          const completeness = deriveCompletenessFromCoverage(
            coverage,
            staleRatio,
            input.thresholds,
          )

          await tx.labelMetricSnapshot.create({
            data: {
              sourceCrawlRunId: input.sourceCrawlRunId,
              triggerWorkItemId: input.triggerWorkItemId,
              labelDefinitionId: label.id,
              observedAt: sharedSnapshotAt,
              sourceWatermarkAt: sharedSnapshotAt,
              populationCount,
              evaluatedCount,
              trueCount,
              prevalence,
              coverage,
              currentCount,
              delayedCount,
              staleCount,
              unknownCount,
              staleRatio,
              trueConfidenceAverage: trueCount > 0 ? trueConfidenceSum / trueCount : undefined,
              falseConfidenceAverage: falseCount > 0 ? falseConfidenceSum / falseCount : undefined,
              confidenceBuckets: confidenceBuckets as Prisma.InputJsonValue,
              reasonDistribution: reasonDistribution as Prisma.InputJsonValue,
              ruleVersionDistribution: ruleVersionDistribution as Prisma.InputJsonValue,
              completeness,
              policyHash: input.policyHash,
              analyzerVersion: input.analyzerVersion,
              analysisRunId: input.analysisRunId,
            },
          })
        }),
      )

      return sharedSnapshotAt
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  )

  return { triggerWorkItemId: input.triggerWorkItemId, snapshotAt, reused: false }
}
