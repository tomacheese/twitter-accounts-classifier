import type { PrismaClient } from '../generated/prisma'
import { rollUpLabelMetricDaily } from './build-label-metric-daily'

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * @param a - 比較対象の severity (null は severity なし扱い)
 * @param b - 比較対象の severity
 * @returns より深刻な方の severity
 */
function maxSeverity(a: string | null, b: string): string {
  if (!a) return b
  return (SEVERITY_RANK[a] ?? 0) >= (SEVERITY_RANK[b] ?? 0) ? a : b
}

/**
 * @param evaluatedCount - 評価件数
 * @param trueCount - true 件数
 * @returns prevalence (evaluatedCount = 0 のときは 0)
 */
function computePrevalence(evaluatedCount: number, trueCount: number): number {
  return evaluatedCount === 0 ? 0 : trueCount / evaluatedCount
}

// 過去の比較対象としては、集計が完全に成立した snapshot だけを使う。
// partial・unknown を比較対象に混ぜると、実際には検出できていない変化を
// prevalence の増減として誤って見せてしまう。
const COMPLETED_SNAPSHOT_FILTER = { completeness: 'complete' } as const

/**
 * buildLabelSummary の入力。
 */
export interface BuildLabelSummaryInput {
  /** 書き込み先の generationId。 */
  generationId: string
  /** 今回の LabelSummaryCurrent の元になる snapshot set の識別子。 */
  triggerWorkItemId: string
  /** 集計の基準時刻。 */
  sourceWatermarkAt: Date
}

/** 比較対象として取得した snapshot の最小限のフィールド。 */
interface ComparableSnapshot {
  evaluatedCount: number
  trueCount: number
}

/**
 * 指定時刻以前で最も新しい snapshot を取得する。
 * 直近 N 件をまとめて取得して絞り込む方式は crawl 間隔が変わると比較対象を取り逃すため、
 * cutoff 時刻を条件にした問い合わせで取得する。
 * @param prisma - Prisma クライアント
 * @param labelDefinitionId - 対象 LabelDefinition の ID
 * @param at - この時刻以前の snapshot を対象にする
 * @returns 該当する snapshot。存在しなければ null
 */
async function findSnapshotAtOrBefore(
  prisma: PrismaClient,
  labelDefinitionId: string,
  at: Date,
): Promise<ComparableSnapshot | null> {
  return prisma.labelMetricSnapshot.findFirst({
    where: { labelDefinitionId, observedAt: { lte: at }, ...COMPLETED_SNAPSHOT_FILTER },
    orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
    select: { evaluatedCount: true, trueCount: true },
  })
}

/**
 * 今回の triggerWorkItemId の snapshot set (buildLabelAggregateSnapshotSet が
 * 構築した、全 LabelDefinition 分の一貫した snapshot 群) から LabelSummaryCurrent を
 * 構築し、Label 詳細のトレンドが参照する LabelMetricDaily も併せて更新する。
 * completeness が complete でない snapshot (unknown・partial) も、古い complete
 * snapshot へフォールバックせずそのまま今回の値として採用する。fallback すると
 * LabelSummary が実際には検出できていない状態を normal のまま見せてしまうため、
 * 代わりに qualityStatus を unknown/watch にして品質の劣化を表示する。
 * Label ごとの読み取りは互いに独立しているため並行実行し、
 * 書き込みは 1 回の createMany にまとめて往復回数を Label 数に比例させない。
 * @param prisma - Prisma クライアント
 * @param input - 対象 generationId・snapshot set の識別子・検索基準時刻
 * @returns 作成した行数
 */
export async function buildLabelSummary(
  prisma: PrismaClient,
  input: BuildLabelSummaryInput,
): Promise<{ rowCount: number }> {
  await rollUpLabelMetricDaily(prisma, { now: input.sourceWatermarkAt })

  const currentSnapshots = await prisma.labelMetricSnapshot.findMany({
    where: { triggerWorkItemId: input.triggerWorkItemId },
  })
  if (currentSnapshots.length === 0) return { rowCount: 0 }

  const rows = await Promise.all(
    currentSnapshots.map(async (current) => {
      const activeFindings = await prisma.reviewFinding.findMany({
        where: {
          status: { in: ['active', 'recurring'] },
          primaryScopeType: 'label',
          primaryScopeId: current.labelDefinitionId,
        },
        select: { currentSeverity: true },
      })

      let highestFindingSeverity: string | null = null
      for (const finding of activeFindings) {
        highestFindingSeverity = maxSeverity(highestFindingSeverity, finding.currentSeverity)
      }

      const prevalence = computePrevalence(current.evaluatedCount, current.trueCount)
      const isComplete = current.completeness === 'complete'

      let previousRunDelta: number | null = null
      let dayDelta: number | null = null
      let weekDelta: number | null = null
      if (isComplete) {
        const [previous, dayAgo, weekAgo] = await Promise.all([
          findSnapshotAtOrBefore(
            prisma,
            current.labelDefinitionId,
            new Date(current.observedAt.getTime() - 1),
          ),
          findSnapshotAtOrBefore(
            prisma,
            current.labelDefinitionId,
            new Date(current.observedAt.getTime() - DAY_MS),
          ),
          findSnapshotAtOrBefore(
            prisma,
            current.labelDefinitionId,
            new Date(current.observedAt.getTime() - 7 * DAY_MS),
          ),
        ])
        const deltaFrom = (snapshot: ComparableSnapshot | null): number | null =>
          snapshot
            ? prevalence - computePrevalence(snapshot.evaluatedCount, snapshot.trueCount)
            : null
        previousRunDelta = deltaFrom(previous)
        dayDelta = deltaFrom(dayAgo)
        weekDelta = deltaFrom(weekAgo)
      }

      const qualityStatus =
        current.completeness === 'unknown'
          ? 'unknown'
          : current.completeness === 'partial'
            ? 'watch'
            : activeFindings.length > 0
              ? 'attention'
              : 'normal'

      return {
        generationId: input.generationId,
        labelDefinitionId: current.labelDefinitionId,
        latestSnapshotId: current.id,
        evaluatedCount: current.evaluatedCount,
        trueCount: current.trueCount,
        populationCount: current.populationCount,
        coverage: current.coverage,
        prevalence,
        previousRunDelta,
        dayDelta,
        weekDelta,
        activeFindingCount: activeFindings.length,
        highestFindingSeverity,
        qualityStatus,
        sourceWatermarkAt: input.sourceWatermarkAt,
      }
    }),
  )

  await prisma.labelSummaryCurrent.createMany({ data: rows })
  return { rowCount: rows.length }
}
