import { Prisma, type PrismaClient } from '../generated/prisma'
import { deleteInBatches } from './batched-delete'
import { MAINTENANCE_BATCH, RETENTION_DAYS } from './config'

const DAY_MS = 24 * 60 * 60 * 1000

/** 削除対象 1 表分の定義。 */
interface RetentionTarget {
  /** 結果の集計キー。 */
  name: string
  table: string
  keyColumns: readonly string[]
  /** 保持期限を過ぎ、かつ参照されていない行の述語。表はエイリアス `t` で参照する。 */
  where: (cutoff: Date) => Prisma.Sql
  retentionDays: number
}

// succeeded は完了時に台帳へ移るため、キュー表の終端状態は dead だけである。
// AnalysisRun.workItemId や AccountClassificationObservation を参照する WorkItem は、
// 終端でない間は参照元を消さない。
const RETENTION_TARGETS: readonly RetentionTarget[] = [
  {
    name: 'deadWorkItem',
    table: 'AnalysisWorkItem',
    keyColumns: ['id'],
    retentionDays: RETENTION_DAYS.deadWorkItem,
    where: (cutoff) => Prisma.sql`t."status" = 'dead' AND t."updatedAt" < ${cutoff}`,
  },
  {
    name: 'analysisWorkItemDone',
    table: 'AnalysisWorkItemDone',
    keyColumns: ['kind', 'triggerType', 'triggerId'],
    retentionDays: RETENTION_DAYS.analysisWorkItemDone,
    where: (cutoff) => Prisma.sql`t."completedAt" < ${cutoff}`,
  },
  {
    name: 'analysisRun',
    table: 'AnalysisRun',
    keyColumns: ['id'],
    retentionDays: RETENTION_DAYS.analysisRun,
    where: (cutoff) => Prisma.sql`
      t."finishedAt" < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "AnalysisWorkItem" w WHERE w."id" = t."workItemId")`,
  },
  {
    name: 'labelMetricSnapshot',
    table: 'LabelMetricSnapshot',
    keyColumns: ['id'],
    retentionDays: RETENTION_DAYS.labelMetricSnapshot,
    where: (cutoff) => Prisma.sql`
      t."observedAt" < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "LabelSummaryCurrent" c WHERE c."latestSnapshotId" = t."id")`,
  },
  {
    // trend 表示のため日数単位で履歴を残す。公開中の世代だけは日数に関わらず残す。
    name: 'overviewSnapshot',
    table: 'OverviewSnapshot',
    keyColumns: ['id'],
    retentionDays: RETENTION_DAYS.overviewSnapshot,
    where: (cutoff) => Prisma.sql`
      t."generatedAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "ReadModelPointer" p
        WHERE p."modelKey" = 'overview_snapshot' AND p."currentGenerationId" = t."generationId"
      )`,
  },
  {
    // 本番判定 (isShadow = false) は無効化前の比較に使うため対象にしない。
    name: 'shadowDetectorEvaluation',
    table: 'DetectorEvaluation',
    keyColumns: ['id'],
    retentionDays: RETENTION_DAYS.shadowDetectorEvaluation,
    where: (cutoff) => Prisma.sql`t."isShadow" AND t."evaluatedAt" < ${cutoff}`,
  },
  {
    // 判定は削除文自身の NOT EXISTS で行う。保護対象を先に一覧で取ると、
    // 取得と削除の間に積まれた WorkItem を取りこぼす。
    name: 'accountClassificationObservation',
    table: 'AccountClassificationObservation',
    keyColumns: ['id'],
    retentionDays: RETENTION_DAYS.accountClassificationObservation,
    where: (cutoff) => Prisma.sql`
      t."observedAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "AnalysisWorkItem" w
        WHERE w."triggerId" = t."id"
          AND w."kind" = 'account_summary_refresh'
          AND w."triggerType" = 'account_classification_observation'
          AND w."status" <> 'dead'
      )`,
  },
  ...(['CrawlAccountCheckpoint', 'CrawlAuthorCheckpoint', 'CrawlAccountLabelRun'] as const).map(
    (table): RetentionTarget => ({
      name: table[0].toLowerCase() + table.slice(1),
      table,
      keyColumns: ['id'],
      retentionDays: RETENTION_DAYS.crawlCheckpoint,
      // 終了しないまま止まった Run も、最後の heartbeat から期限を数えて対象にする。
      where: (cutoff) => Prisma.sql`
        EXISTS (
          SELECT 1 FROM "CrawlRun" r
          WHERE r."id" = t."crawlRunId" AND COALESCE(r."finishedAt", r."lastHeartbeatAt") < ${cutoff}
        )`,
    }),
  ),
  // 現在の Occurrence は親が currentOccurrenceId で指しており、期限内外を問わず残す。
  {
    name: 'operationalIssueOccurrence',
    table: 'OperationalIssueOccurrence',
    keyColumns: ['id'],
    retentionDays: RETENTION_DAYS.operationalIssueOccurrence,
    where: (cutoff) => Prisma.sql`
      t."observedAt" < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "OperationalIssue" i WHERE i."currentOccurrenceId" = t."id")`,
  },
  {
    name: 'reviewFindingOccurrence',
    table: 'ReviewFindingOccurrence',
    keyColumns: ['id'],
    retentionDays: RETENTION_DAYS.reviewFindingOccurrence,
    where: (cutoff) => Prisma.sql`
      t."observedAt" < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "ReviewFinding" f WHERE f."currentOccurrenceId" = t."id")`,
  },
]

export interface RetentionSweepOptions {
  /** true のとき何も削除せず、削除対象の行数を数える。 */
  dryRun?: boolean
  /** 表ごとのバッチ数の上限。既定は MAINTENANCE_BATCH の値。 */
  maxBatchesPerTable?: number
  batchSize?: number
  pauseMs?: number
}

/** runRetentionSweep の結果。キーは RetentionTarget.name。 */
export interface RetentionSweepResult {
  /** 削除した行数 (dryRun では削除対象の行数)。 */
  counts: Record<string, number>
  /** バッチ数の上限で打ち切り、次回に持ち越す対象が残っている表。 */
  truncatedTables: string[]
}

/**
 * analyzer が積み上げる履歴テーブルを、保持期間に応じて小さなバッチで削除する。
 * 期限ちょうどの行は残し、それより前の行だけを削除する。
 * @param now - 基準時刻
 */
export async function runRetentionSweep(
  prisma: PrismaClient,
  now: Date,
  options: RetentionSweepOptions = {},
): Promise<RetentionSweepResult> {
  const counts: Record<string, number> = {}
  const truncatedTables: string[] = []

  for (const target of RETENTION_TARGETS) {
    const cutoff = new Date(now.getTime() - target.retentionDays * DAY_MS)
    const result = await deleteInBatches(prisma, {
      table: target.table,
      keyColumns: target.keyColumns,
      where: target.where(cutoff),
      batchSize: options.batchSize ?? MAINTENANCE_BATCH.deleteBatchSize,
      maxBatches: options.maxBatchesPerTable ?? MAINTENANCE_BATCH.maxDeleteBatchesPerTable,
      pauseMs: options.pauseMs ?? MAINTENANCE_BATCH.pauseMs,
      dryRun: options.dryRun ?? false,
    })
    counts[target.name] = result.count
    if (result.hasMore) truncatedTables.push(target.name)
  }

  return { counts, truncatedTables }
}
