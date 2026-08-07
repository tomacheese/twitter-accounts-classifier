import type { PrismaClient } from '../generated/prisma'

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }

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

/**
 * buildLabelSummary の入力。
 */
export interface BuildLabelSummaryInput {
  /** 書き込み先の generationId。 */
  generationId: string
  /** 集計の基準時刻。 */
  sourceWatermarkAt: Date
}

/**
 * LabelDefinition ごとに最新の LabelMetricSnapshot と、直近の日次・週次比較用 snapshot、
 * 対応する ReviewFinding の active/recurring 件数を集約して LabelSummaryCurrent を構築する。
 * Label ごとの 2 本の読み取りは互いに独立しているため並行実行し、
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
      const [snapshots, activeFindings] = await Promise.all([
        prisma.labelMetricSnapshot.findMany({
          where: { labelDefinitionId: labelDefinition.id },
          orderBy: [{ observedAt: 'desc' }],
          take: 8,
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

      const latest = snapshots.at(0)
      if (!latest) return undefined

      const previous = snapshots.at(1)
      const dayAgo = snapshots.find(
        (snapshot) =>
          latest.observedAt.getTime() - snapshot.observedAt.getTime() >= 24 * 60 * 60 * 1000,
      )
      const weekAgo = snapshots.find(
        (snapshot) =>
          latest.observedAt.getTime() - snapshot.observedAt.getTime() >= 7 * 24 * 60 * 60 * 1000,
      )

      let highestFindingSeverity: string | null = null
      for (const finding of activeFindings) {
        highestFindingSeverity = maxSeverity(highestFindingSeverity, finding.currentSeverity)
      }

      const prevalence = computePrevalence(latest.evaluatedCount, latest.trueCount)
      const previousRunDelta = previous
        ? prevalence - computePrevalence(previous.evaluatedCount, previous.trueCount)
        : null
      const dayDelta = dayAgo
        ? prevalence - computePrevalence(dayAgo.evaluatedCount, dayAgo.trueCount)
        : null
      const weekDelta = weekAgo
        ? prevalence - computePrevalence(weekAgo.evaluatedCount, weekAgo.trueCount)
        : null

      return {
        generationId: input.generationId,
        labelDefinitionId: labelDefinition.id,
        latestSnapshotId: latest.id,
        evaluatedCount: latest.evaluatedCount,
        trueCount: latest.trueCount,
        prevalence,
        previousRunDelta,
        dayDelta,
        weekDelta,
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
