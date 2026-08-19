import { Logger } from '@book000/node-utils'
import { Prisma, type PrismaClient } from '../generated/prisma'

/** LabelMetricSnapshot.completeness の値。 */
export type SnapshotCompleteness = 'complete' | 'partial' | 'unknown'

const logger = Logger.configure('metrics/label-metric-snapshot')

const CONFIDENCE_BUCKET_COUNT = 10
const FRESHNESS_BUCKET_BACKLOG_CEILING_MS = 7 * 24 * 60 * 60 * 1000
const MIN_FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000
// 集計テーブル読み取りへの置き換えにより行数に依存しない O(labelDefinition数) の
// トランザクションになったため、旧 COUNT(DISTINCT) 全件scan を見込んだ 300 秒は
// 過大。account_summary_refresh と同じ水準に合わせる。
const LABEL_AGGREGATE_SNAPSHOT_TRANSACTION_TIMEOUT_MS = 60_000
// compaction は全 labelDefinitionId を一括で SKIP LOCKED 取得するだけの短時間処理であり、
// Prisma の既定 5 秒 timeout では単発の遅延クエリでも簡単に超過するため、余裕を明示する。
const FRESHNESS_COMPACTION_TRANSACTION_TIMEOUT_MS = 30_000

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
        AND "observedAtBucket" < (now() AT TIME ZONE 'UTC') - interval '7 days'
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
      AND "observedAtBucket" < (now() AT TIME ZONE 'UTC') - interval '7 days'
      AND "observedAtBucket" <> TIMESTAMP '1970-01-01'
  `
}

/**
 * 全 labelDefinitionId の freshness バケットを、ラベルごとに分けず
 * 固定回数の SQL 文で一括 compaction する。sentinel 行のロックは
 * labelDefinitionId 昇順・SKIP LOCKED で取得し、トリガー側のロック順序とは揃えつつ、
 * 分類書き込み側と競合しているロックはそのまま読み飛ばす。全件を待ち合わせる設計だと、
 * 1件の競合が compaction 全体の所要時間に積み上がり timeout の主因になるため、
 * 競合した labelDefinitionId は今回の compaction 対象から外し次回に委ねる。
 * snapshot 本体の REPEATABLE READ トランザクションより先に、それとは
 * 独立した短時間トランザクションとして実行することで、分類書き込み側が
 * 待たされる時間を compaction 自体の実行時間に限定する。
 * @param prisma - Prisma クライアント
 * @param labelIds - 対象の labelDefinitionId 一覧
 */
async function compactFreshnessBucketsForAllLabels(
  prisma: PrismaClient,
  labelIds: string[],
): Promise<void> {
  if (labelIds.length === 0) return
  const sortedLabelIds = labelIds.toSorted()
  const startedAt = performance.now()

  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "AccountClassificationFreshnessBucket" ("labelDefinitionId", "observedAtBucket", "count")
        SELECT "id", TIMESTAMP '1970-01-01', 0
        FROM UNNEST(${sortedLabelIds}::text[]) AS "id"
        ON CONFLICT DO NOTHING
      `

      const lockedAt = performance.now()
      const lockedRows = await tx.$queryRaw<{ labelDefinitionId: string }[]>`
        SELECT "labelDefinitionId" FROM "AccountClassificationFreshnessBucket"
        WHERE "labelDefinitionId" = ANY(${sortedLabelIds}::text[]) AND "observedAtBucket" = TIMESTAMP '1970-01-01'
        ORDER BY "labelDefinitionId"
        FOR UPDATE SKIP LOCKED
      `
      const lockWaitMs = performance.now() - lockedAt
      const lockedLabelIds = lockedRows.map((row) => row.labelDefinitionId)
      if (lockedLabelIds.length < sortedLabelIds.length) {
        logger.warn(
          `compactFreshnessBucketsForAllLabels skipped ${sortedLabelIds.length - lockedLabelIds.length} of ${sortedLabelIds.length} labelDefinitionId(s) held by a concurrent writer (lockWaitMs=${lockWaitMs.toFixed(1)})`,
        )
      }
      if (lockedLabelIds.length === 0) return

      await tx.$executeRaw`
        WITH stale_totals AS (
          SELECT "labelDefinitionId", SUM("count") AS total
          FROM "AccountClassificationFreshnessBucket"
          WHERE "labelDefinitionId" = ANY(${lockedLabelIds}::text[])
            AND "observedAtBucket" < (now() AT TIME ZONE 'UTC') - interval '7 days'
            AND "observedAtBucket" <> TIMESTAMP '1970-01-01'
          GROUP BY 1
        )
        UPDATE "AccountClassificationFreshnessBucket" AS sentinel
        SET "count" = sentinel."count" + stale_totals."total"
        FROM stale_totals
        WHERE sentinel."labelDefinitionId" = stale_totals."labelDefinitionId"
          AND sentinel."observedAtBucket" = TIMESTAMP '1970-01-01'
      `
      await tx.$executeRaw`
        DELETE FROM "AccountClassificationFreshnessBucket"
        WHERE "labelDefinitionId" = ANY(${lockedLabelIds}::text[])
          AND "observedAtBucket" < (now() AT TIME ZONE 'UTC') - interval '7 days'
          AND "observedAtBucket" <> TIMESTAMP '1970-01-01'
      `
    },
    { timeout: FRESHNESS_COMPACTION_TRANSACTION_TIMEOUT_MS },
  )

  logger.debug(
    `compactFreshnessBucketsForAllLabels took ${(performance.now() - startedAt).toFixed(1)}ms for ${sortedLabelIds.length} labelDefinitionId(s)`,
  )
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

/** AccountClassificationValueCount の読み取り行。 */
interface ValueCountRow {
  labelDefinitionId: string
  value: boolean
  // AccountClassificationValueCount.count は INTEGER 列の直接 SELECT であり、
  // COUNT(*) 等の集約ではないため node-postgres 経由でも number になる。
  count: number
  confidenceSum: number
}
/** AccountClassificationConfidenceBucketCount の読み取り行。 */
interface ConfidenceBucketCountRow {
  labelDefinitionId: string
  confidenceBucket: number
  count: number
}
/** AccountClassificationRuleVersionCount の読み取り行。 */
interface RuleVersionCountRow {
  labelDefinitionId: string
  ruleVersion: string
  count: number
}
/** AccountClassificationFreshnessBucket を current/delayed/stale に振り分け集計した行。 */
interface FreshnessCountRow {
  labelDefinitionId: string
  currentCount: bigint | null
  delayedCount: bigint | null
  staleCount: bigint | null
}
/** AccountClassificationReasonCount の読み取り行。 */
interface ReasonCountRow {
  labelDefinitionId: string
  reason: string
  // AccountClassificationReasonCount.count は INTEGER 列の直接 SELECT であり、
  // COUNT(*) 等の集約ではないため node-postgres 経由でも number になる。
  count: number
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

  // snapshot 本体の REPEATABLE READ トランザクションより先に、独立した
  // 短時間トランザクションで compaction を済ませる。同一トランザクション内で
  // 行うと、compaction の sentinel ロックが分類書き込み側のトリガーと
  // snapshot トランザクションのタイムアウト全体で競合し得るため。
  await compactFreshnessBucketsForAllLabels(prisma, labelIds)

  const snapshotAt = await prisma.$transaction(
    async (tx) => {
      const nowRows = await tx.$queryRaw<{ now: Date }[]>`SELECT now() AS now`
      const sharedSnapshotAt = nowRows.at(0)?.now ?? new Date()

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
                SELECT "labelDefinitionId", "reason", "count"
                FROM "AccountClassificationReasonCount"
                WHERE "labelDefinitionId" IN (${Prisma.join(labelIds)})
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
            const count = row.count
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
            confidenceBuckets[formatConfidenceBucketKey(row.confidenceBucket)] = row.count
          }

          const ruleVersionDistribution: Record<string, number> = {}
          for (const row of ruleVersionRowsByLabel.get(label.id) ?? []) {
            ruleVersionDistribution[row.ruleVersion] = row.count
          }

          const reasonDistribution: Record<string, number> = {}
          for (const row of reasonRowsByLabel.get(label.id) ?? []) {
            reasonDistribution[row.reason] = row.count
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
      timeout: LABEL_AGGREGATE_SNAPSHOT_TRANSACTION_TIMEOUT_MS,
    },
  )

  return { triggerWorkItemId: input.triggerWorkItemId, snapshotAt, reused: false }
}

export {
  compactFreshnessBuckets as compactFreshnessBucketsForTest,
  compactFreshnessBucketsForAllLabels as compactFreshnessBucketsForAllLabelsForTest,
}
