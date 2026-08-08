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
