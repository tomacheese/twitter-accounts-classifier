import type { PrismaClient } from '../generated/prisma'

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

/** 集計に成功した snapshot だけを対象にする where 条件。 */
const COMPLETED_SNAPSHOT_FILTER = { completeness: { not: 'unknown' } } as const

/**
 * buildLabelSummary の入力。
 */
export interface BuildLabelSummaryInput {
  /** 書き込み先の generationId。 */
  generationId: string
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
 * LabelDefinition ごとに最新の LabelMetricSnapshot と、直近の日次・週次比較用 snapshot、
 * 対応する ReviewFinding の active/recurring 件数を集約して LabelSummaryCurrent を構築する。
 * completeness が unknown の snapshot は集計自体に失敗した記録であり、
 * prevalence を 0 とみなすと誤った下落として伝播するため対象から除く。
 * Label ごとの読み取りは互いに独立しているため並行実行し、
 * 書き込みは 1 回の createMany にまとめて往復回数を Label 数に比例させない。
 * @param prisma - Prisma クライアント
 * @param input - 対象 generationId と検索基準時刻
 * @returns 作成した行数
 */
export async function buildLabelSummary(
  prisma: PrismaClient,
  input: BuildLabelSummaryInput,
): Promise<{ rowCount: number }> {
  const labelDefinitions = await prisma.labelDefinition.findMany({ select: { id: true } })

  const rows = await Promise.all(
    labelDefinitions.map(async (labelDefinition) => {
      const [recentSnapshots, activeFindings] = await Promise.all([
        prisma.labelMetricSnapshot.findMany({
          where: { labelDefinitionId: labelDefinition.id, ...COMPLETED_SNAPSHOT_FILTER },
          orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
          take: 2,
        }),
        prisma.reviewFinding.findMany({
          where: {
            status: { in: ['active', 'recurring'] },
            primaryScopeType: 'label',
            primaryScopeId: labelDefinition.id,
          },
          select: { currentSeverity: true },
        }),
      ])

      const latest = recentSnapshots.at(0)
      if (!latest) return undefined

      const previous = recentSnapshots.at(1)
      const [dayAgo, weekAgo] = await Promise.all([
        findSnapshotAtOrBefore(
          prisma,
          labelDefinition.id,
          new Date(latest.observedAt.getTime() - DAY_MS),
        ),
        findSnapshotAtOrBefore(
          prisma,
          labelDefinition.id,
          new Date(latest.observedAt.getTime() - 7 * DAY_MS),
        ),
      ])

      let highestFindingSeverity: string | null = null
      for (const finding of activeFindings) {
        highestFindingSeverity = maxSeverity(highestFindingSeverity, finding.currentSeverity)
      }

      const prevalence = computePrevalence(latest.evaluatedCount, latest.trueCount)
      const deltaFrom = (snapshot: ComparableSnapshot | null | undefined): number | null =>
        snapshot ? prevalence - computePrevalence(snapshot.evaluatedCount, snapshot.trueCount) : null

      return {
        generationId: input.generationId,
        labelDefinitionId: labelDefinition.id,
        latestSnapshotId: latest.id,
        evaluatedCount: latest.evaluatedCount,
        trueCount: latest.trueCount,
        prevalence,
        previousRunDelta: deltaFrom(previous),
        dayDelta: deltaFrom(dayAgo),
        weekDelta: deltaFrom(weekAgo),
        activeFindingCount: activeFindings.length,
        highestFindingSeverity,
        qualityStatus: activeFindings.length > 0 ? 'attention' : 'normal',
        sourceWatermarkAt: input.sourceWatermarkAt,
      }
    }),
  )

  const data = rows.filter((row) => row !== undefined)
  if (data.length === 0) return { rowCount: 0 }

  await prisma.labelSummaryCurrent.createMany({ data })

  return { rowCount: data.length }
}
