import type { PrismaClient } from '../../generated/prisma'

/** Label 詳細のトレンド表示期間。 */
export type LabelDetailRangePreset = '24h' | '7d' | '30d' | '90d'

/** getLabelDetail の入力。 */
export interface GetLabelDetailInput {
  range?: LabelDetailRangePreset
}

const RANGE_TO_DAYS: Record<LabelDetailRangePreset, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

/** トレンドグラフの 1 点。 */
export interface LabelDetailTrendPoint {
  date: Date
  prevalence: number
  evaluatedCount: number
  trueCount: number
}

/** Label 詳細の表示内容。 */
export interface LabelDetailView {
  labelKey: string
  description: string
  latestSnapshot: {
    prevalence: number
    evaluatedCount: number
    trueCount: number
    observedAt: Date
  } | null
  /** 最新の集計が失敗しており、表示中の値がそれより前の観測である場合に true。 */
  latestAggregationFailed: boolean
  trend: LabelDetailTrendPoint[]
  activeFindings: { findingId: string; type: string; currentSeverity: string }[]
}

/**
 * トレンドは `LabelMetricSnapshot` ではなく `LabelMetricDaily` から取得する。
 * 前者は crawl 単位で全件保持しており、
 * 期間 filter なしで走査すると履歴が伸びるほど遅くなるため。
 * completeness が unknown の snapshot は集計失敗の記録であり、
 * 通常値として表示すると prevalence 0 の急落に見えるため最新値には採用しない。
 * @param prisma - Prisma クライアント
 * @param labelKey - `LabelDefinition.key` (表示名変更の影響を受けない安定識別子)
 * @param input - 期間 preset
 * @returns Label 詳細。存在しなければ null
 */
export async function getLabelDetail(
  prisma: PrismaClient,
  labelKey: string,
  input: GetLabelDetailInput = {},
): Promise<LabelDetailView | null> {
  const labelDefinition = await prisma.labelDefinition.findUnique({ where: { key: labelKey } })
  if (!labelDefinition) return null

  const range = input.range ?? '30d'
  const since = new Date(Date.now() - RANGE_TO_DAYS[range] * 24 * 60 * 60 * 1000)

  const [latestSnapshot, newestSnapshot, dailyRows, activeFindings] = await Promise.all([
    prisma.labelMetricSnapshot.findFirst({
      where: { labelDefinitionId: labelDefinition.id, completeness: { not: 'unknown' } },
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
    }),
    prisma.labelMetricSnapshot.findFirst({
      where: { labelDefinitionId: labelDefinition.id },
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      select: { completeness: true },
    }),
    prisma.labelMetricDaily.findMany({
      where: { labelDefinitionId: labelDefinition.id, date: { gte: since } },
      orderBy: [{ date: 'asc' }],
    }),
    prisma.reviewFinding.findMany({
      where: {
        primaryScopeType: 'label',
        primaryScopeId: labelDefinition.id,
        status: { in: ['active', 'recurring'] },
      },
      orderBy: [{ lastDetectedAt: 'desc' }],
    }),
  ])

  return {
    labelKey: labelDefinition.key,
    description: labelDefinition.description,
    latestSnapshot: latestSnapshot
      ? {
          prevalence: latestSnapshot.prevalence,
          evaluatedCount: latestSnapshot.evaluatedCount,
          trueCount: latestSnapshot.trueCount,
          observedAt: latestSnapshot.observedAt,
        }
      : null,
    latestAggregationFailed: newestSnapshot?.completeness === 'unknown',
    trend: dailyRows.map((row) => ({
      date: row.date,
      prevalence: row.prevalence,
      evaluatedCount: row.evaluatedCount,
      trueCount: row.trueCount,
    })),
    activeFindings: activeFindings.map((finding) => ({
      findingId: finding.id,
      type: finding.type,
      currentSeverity: finding.currentSeverity,
    })),
  }
}
