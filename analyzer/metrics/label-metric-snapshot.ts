import { Prisma, type PrismaClient } from '../generated/prisma'

/** LabelMetricSnapshot.completeness の値。 */
export type SnapshotCompleteness = 'complete' | 'partial' | 'unknown'

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
  labelDefinitionId: string
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
    if (!row) {
      // 直前の count と矛盾する状態。fabricate した時刻で reuse させると
      // 誤った watermark が下流へ伝播するため、ここで検知して失敗させる。
      throw new Error(
        `labelMetricSnapshot count/findFirst mismatch for triggerWorkItemId=${input.triggerWorkItemId}`,
      )
    }
    return {
      triggerWorkItemId: input.triggerWorkItemId,
      snapshotAt: row.observedAt,
      reused: true,
    }
  }

  const freshnessThresholds = input.freshnessThresholdsMs

  const snapshotAt = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL work_mem = '256MB'`
      const nowRows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
      const sharedSnapshotAt = nowRows.at(0)?.now ?? new Date()

      const populationRows = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(DISTINCT "accountId") AS count FROM "AccountClassificationLatest"
      `
      const populationCount = Number(populationRows.at(0)?.count ?? 0)

      // freshness (current/delayed/stale) を JS 側で行ごとに判定すると、
      // GROUP BY に observedAt の生値が必要になり、Account 数に比例して行数が
      // 増えてしまう。FILTER 句で current/delayed/stale の件数自体を SQL 側で
      // 集計し、GROUP BY は value/reason/ruleVersion/confidenceBucket の
      // 有限な組み合わせのみに保つ。
      const delayedAfterSeconds = freshnessThresholds.delayedAfterMs / 1000
      const staleAfterSeconds = freshnessThresholds.staleAfterMs / 1000

      const aggregateRows: AggregateSnapshotRow[] =
        labelDefinitions.length === 0
          ? []
          : await tx.$queryRaw<AggregateSnapshotRow[]>`
              SELECT
                "labelDefinitionId", "value", "reason", "ruleVersion",
                LEAST(FLOOR("confidence" * 10), 9)::int AS "confidenceBucket",
                COUNT(*) AS "count",
                SUM("confidence") AS "confidenceSum",
                COUNT(*) FILTER (
                  WHERE ${sharedSnapshotAt}::timestamp - "observedAt" <= make_interval(secs => ${delayedAfterSeconds})
                ) AS "currentCount",
                COUNT(*) FILTER (
                  WHERE ${sharedSnapshotAt}::timestamp - "observedAt" > make_interval(secs => ${delayedAfterSeconds})
                    AND ${sharedSnapshotAt}::timestamp - "observedAt" <= make_interval(secs => ${staleAfterSeconds})
                ) AS "delayedCount",
                COUNT(*) FILTER (
                  WHERE ${sharedSnapshotAt}::timestamp - "observedAt" > make_interval(secs => ${staleAfterSeconds})
                ) AS "staleCount"
              FROM "AccountClassificationLatest"
              WHERE "labelDefinitionId" IN (${Prisma.join(labelDefinitions.map((label) => label.id))})
              GROUP BY 1, 2, 3, 4, 5
            `

      const rowsByLabelDefinitionId = new Map<string, AggregateSnapshotRow[]>()
      for (const row of aggregateRows) {
        const rows = rowsByLabelDefinitionId.get(row.labelDefinitionId) ?? []
        rows.push(row)
        rowsByLabelDefinitionId.set(row.labelDefinitionId, rows)
      }

      await Promise.all(
        labelDefinitions.map(async (label) => {
          const rows = rowsByLabelDefinitionId.get(label.id) ?? []
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

          // 前回 attempt が一部の LabelDefinition だけ commit 済みの状態
          // (この attempt の後に LabelDefinition が追加された等) で retry されても、
          // 既存行との一意制約違反で永久に失敗し続けないよう upsert にし、
          // 既存行にはそのまま触れない (insert-only の方針を保つ)。
          await tx.labelMetricSnapshot.upsert({
            where: {
              triggerWorkItemId_labelDefinitionId: {
                triggerWorkItemId: input.triggerWorkItemId,
                labelDefinitionId: label.id,
              },
            },
            update: {},
            create: {
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
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 300_000,
    },
  )

  return { triggerWorkItemId: input.triggerWorkItemId, snapshotAt, reused: false }
}
