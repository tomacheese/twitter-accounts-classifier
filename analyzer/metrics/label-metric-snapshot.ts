import { Prisma, type PrismaClient } from '../generated/prisma'

/** LabelMetricSnapshot.completeness の値。 */
export type SnapshotCompleteness = 'complete' | 'partial' | 'unknown'

const CONFIDENCE_BUCKET_COUNT = 10
const FRESHNESS_BUCKET_BACKLOG_CEILING_MS = 7 * 24 * 60 * 60 * 1000
const MIN_FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000

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

/**
 * read_model_freshness policy の delayedAfter/staleAfter が、
 * freshness バケットの sentinel 丸め・分単位丸めの前提と矛盾しないことを検査する。
 * 矛盾する policy 変更をコード変更・migration レビューを伴わずに投入できないようにする契約。
 * @param freshnessThresholdsMs - 検査対象の閾値
 */
function assertFreshnessThresholdsCompatibleWithBucketing(freshnessThresholdsMs: {
  delayedAfterMs: number
  staleAfterMs: number
}): void {
  if (freshnessThresholdsMs.staleAfterMs > FRESHNESS_BUCKET_BACKLOG_CEILING_MS) {
    throw new Error(
      `staleAfterMs (${freshnessThresholdsMs.staleAfterMs}) must not exceed ` +
        `FRESHNESS_BUCKET_BACKLOG_CEILING_MS (${FRESHNESS_BUCKET_BACKLOG_CEILING_MS})`,
    )
  }
  if (
    freshnessThresholdsMs.delayedAfterMs < MIN_FRESHNESS_THRESHOLD_MS ||
    freshnessThresholdsMs.staleAfterMs < MIN_FRESHNESS_THRESHOLD_MS
  ) {
    throw new Error(
      `delayedAfterMs/staleAfterMs must be at least ${MIN_FRESHNESS_THRESHOLD_MS}ms ` +
        `(minute-level bucket rounding granularity)`,
    )
  }
}

/**
 * 分単位バケットのうち 7 日を超えたものを sentinel へ丸め込んで削除する。
 * sentinel 行を必ず先に FOR UPDATE でロックしてから対象バケットをロックし、
 * トリガー側のロック順序と一致させてデッドロックを防ぐ。
 * @param tx - トランザクション内 Prisma クライアント
 * @param labelDefinitionId - 対象の labelDefinitionId
 */
async function compactFreshnessBuckets(
  tx: Prisma.TransactionClient,
  labelDefinitionId: string,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "AccountClassificationFreshnessBucket" ("labelDefinitionId", "observedAtBucket", "count")
    VALUES (${labelDefinitionId}, TIMESTAMP '1970-01-01', 0)
    ON CONFLICT DO NOTHING
  `
  await tx.$queryRaw`
    SELECT * FROM "AccountClassificationFreshnessBucket"
    WHERE "labelDefinitionId" = ${labelDefinitionId} AND "observedAtBucket" = TIMESTAMP '1970-01-01'
    FOR UPDATE
  `
  await tx.$executeRaw`
    WITH stale_buckets AS (
      SELECT "observedAtBucket", "count"
      FROM "AccountClassificationFreshnessBucket"
      WHERE "labelDefinitionId" = ${labelDefinitionId}
        AND "observedAtBucket" < now() - interval '7 days'
        AND "observedAtBucket" <> TIMESTAMP '1970-01-01'
      FOR UPDATE
    )
    UPDATE "AccountClassificationFreshnessBucket" AS sentinel
    SET "count" = sentinel."count" + (SELECT COALESCE(SUM("count"), 0) FROM stale_buckets)
    WHERE sentinel."labelDefinitionId" = ${labelDefinitionId}
      AND sentinel."observedAtBucket" = TIMESTAMP '1970-01-01'
  `
  await tx.$executeRaw`
    DELETE FROM "AccountClassificationFreshnessBucket"
    WHERE "labelDefinitionId" = ${labelDefinitionId}
      AND "observedAtBucket" < now() - interval '7 days'
      AND "observedAtBucket" <> TIMESTAMP '1970-01-01'
  `
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

interface ValueCountRow {
  labelDefinitionId: string
  value: boolean
  count: bigint
  confidenceSum: number
}
interface ConfidenceBucketCountRow {
  labelDefinitionId: string
  confidenceBucket: number
  count: bigint
}
interface RuleVersionCountRow {
  labelDefinitionId: string
  ruleVersion: string
  count: bigint
}
interface FreshnessCountRow {
  labelDefinitionId: string
  currentCount: bigint | null
  delayedCount: bigint | null
  staleCount: bigint | null
}
interface ReasonCountRow {
  labelDefinitionId: string
  reason: string
  count: bigint
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
  assertFreshnessThresholdsCompatibleWithBucketing(input.freshnessThresholdsMs)

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
  const labelIds = labelDefinitions.map((label) => label.id)
  const sortedLabelIds = labelIds.toSorted()

  const snapshotAt = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL work_mem = '256MB'`
      const nowRows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
      const sharedSnapshotAt = nowRows.at(0)?.now ?? new Date()

      // buildLabelAggregateSnapshotSet が呼ばれるたびに、
      // 7 日を超えた freshness バケットを sentinel へ丸め込む。
      // labelDefinitionId を昇順に処理し、
      // トリガー側のロック取得順序と一致させる。
      for (const labelDefinitionId of sortedLabelIds) {
        await compactFreshnessBuckets(tx, labelDefinitionId)
      }

      const populationRows = await tx.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count FROM "AccountSummaryLatest" WHERE "classificationObservedAt" IS NOT NULL
      `
      const populationCount = Number(populationRows.at(0)?.count ?? 0)

      const delayedAfterSeconds = freshnessThresholds.delayedAfterMs / 1000
      const staleAfterSeconds = freshnessThresholds.staleAfterMs / 1000

      const [valueRows, confidenceRows, ruleVersionRows, freshnessRows, reasonRows] =
        labelIds.length === 0
          ? [[], [], [], [], []]
          : await Promise.all([
              tx.$queryRaw<ValueCountRow[]>`
                SELECT "labelDefinitionId", "value", "count", "confidenceSum"
                FROM "AccountClassificationValueCount"
                WHERE "labelDefinitionId" IN (${Prisma.join(labelIds)})
              `,
              tx.$queryRaw<ConfidenceBucketCountRow[]>`
                SELECT "labelDefinitionId", "confidenceBucket", "count"
                FROM "AccountClassificationConfidenceBucketCount"
                WHERE "labelDefinitionId" IN (${Prisma.join(labelIds)})
              `,
              tx.$queryRaw<RuleVersionCountRow[]>`
                SELECT "labelDefinitionId", "ruleVersion", "count"
                FROM "AccountClassificationRuleVersionCount"
                WHERE "labelDefinitionId" IN (${Prisma.join(labelIds)})
              `,
              tx.$queryRaw<FreshnessCountRow[]>`
                SELECT
                  "labelDefinitionId",
                  SUM("count") FILTER (
                    WHERE ${sharedSnapshotAt}::timestamp - "observedAtBucket" <= make_interval(secs => ${delayedAfterSeconds})
                  ) AS "currentCount",
                  SUM("count") FILTER (
                    WHERE ${sharedSnapshotAt}::timestamp - "observedAtBucket" > make_interval(secs => ${delayedAfterSeconds})
                      AND ${sharedSnapshotAt}::timestamp - "observedAtBucket" <= make_interval(secs => ${staleAfterSeconds})
                  ) AS "delayedCount",
                  SUM("count") FILTER (
                    WHERE ${sharedSnapshotAt}::timestamp - "observedAtBucket" > make_interval(secs => ${staleAfterSeconds})
                  ) AS "staleCount"
                FROM "AccountClassificationFreshnessBucket"
                WHERE "labelDefinitionId" IN (${Prisma.join(labelIds)})
                GROUP BY 1
              `,
              tx.$queryRaw<ReasonCountRow[]>`
                SELECT "labelDefinitionId", "reason", COUNT(*) AS count
                FROM "AccountClassificationLatest"
                WHERE "labelDefinitionId" IN (${Prisma.join(labelIds)}) AND "value" = true
                GROUP BY 1, 2
              `,
            ])

      const groupByLabel = <T extends { labelDefinitionId: string }>(
        rows: T[],
      ): Map<string, T[]> => {
        const map = new Map<string, T[]>()
        for (const row of rows) {
          const group = map.get(row.labelDefinitionId) ?? []
          group.push(row)
          map.set(row.labelDefinitionId, group)
        }
        return map
      }
      const valueRowsByLabel = groupByLabel(valueRows)
      const confidenceRowsByLabel = groupByLabel(confidenceRows)
      const ruleVersionRowsByLabel = groupByLabel(ruleVersionRows)
      const reasonRowsByLabel = groupByLabel(reasonRows)
      const freshnessRowByLabel = new Map(freshnessRows.map((row) => [row.labelDefinitionId, row]))

      await Promise.all(
        labelDefinitions.map(async (label) => {
          let evaluatedCount = 0
          let trueCount = 0
          let falseCount = 0
          let trueConfidenceSum = 0
          let falseConfidenceSum = 0
          for (const row of valueRowsByLabel.get(label.id) ?? []) {
            const count = Number(row.count)
            evaluatedCount += count
            if (row.value) {
              trueCount += count
              trueConfidenceSum += row.confidenceSum
            } else {
              falseCount += count
              falseConfidenceSum += row.confidenceSum
            }
          }

          const confidenceBuckets: Record<string, number> = {}
          for (const row of confidenceRowsByLabel.get(label.id) ?? []) {
            confidenceBuckets[formatConfidenceBucketKey(row.confidenceBucket)] = Number(row.count)
          }

          const ruleVersionDistribution: Record<string, number> = {}
          for (const row of ruleVersionRowsByLabel.get(label.id) ?? []) {
            ruleVersionDistribution[row.ruleVersion] = Number(row.count)
          }

          const reasonDistribution: Record<string, number> = {}
          for (const row of reasonRowsByLabel.get(label.id) ?? []) {
            reasonDistribution[row.reason] = Number(row.count)
          }

          const freshnessRow = freshnessRowByLabel.get(label.id)
          const currentCount = Number(freshnessRow?.currentCount ?? 0n)
          const delayedCount = Number(freshnessRow?.delayedCount ?? 0n)
          const staleCount = Number(freshnessRow?.staleCount ?? 0n)

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

export { compactFreshnessBuckets as compactFreshnessBucketsForTest }
