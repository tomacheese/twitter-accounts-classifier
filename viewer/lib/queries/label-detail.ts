import type { PrismaClient } from '../../generated/prisma'

export type LabelDetailRangePreset = '24h' | '7d' | '30d' | '90d'

export interface GetLabelDetailInput {
  range?: LabelDetailRangePreset
}

const RANGE_TO_DAYS: Record<LabelDetailRangePreset, number> = {
  '24h': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
}

export interface LabelDetailTrendPoint {
  date: Date
  prevalence: number
  evaluatedCount: number
  trueCount: number
}

export interface LabelDetailView {
  labelKey: string
  description: string
  latestSnapshot: {
    prevalence: number
    evaluatedCount: number
    trueCount: number
    observedAt: Date
  } | null
  trend: LabelDetailTrendPoint[]
  activeFindings: { findingId: string; type: string; currentSeverity: string }[]
}

/**
 * トレンドは `LabelMetricSnapshot` (crawl 単位、全件保持) ではなく
 * `LabelMetricDaily` (日次ロールアップ) から取得する。`LabelMetricSnapshot` を
 * 期間 filter なしで全件スキャンすると、履歴が伸びるほど遅くなるため。
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

  const [latestSnapshot, dailyRows, activeFindings] = await Promise.all([
    prisma.labelMetricSnapshot.findFirst({
      where: { labelDefinitionId: labelDefinition.id },
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
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
