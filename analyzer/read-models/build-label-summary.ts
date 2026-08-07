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

export interface BuildLabelSummaryInput {
  generationId: string
  sourceWatermarkAt: Date
}

/**
 * LabelDefinition ごとに最新の LabelMetricSnapshot と、直近の日次・週次比較用 snapshot、
 * 対応する ReviewFinding の active/recurring 件数を集約して LabelSummaryCurrent を構築する。
 * @param prisma - Prisma クライアント
 * @param input - 対象 generationId と検索基準時刻
 * @returns 作成した行数
 */
export async function buildLabelSummary(
  prisma: PrismaClient,
  input: BuildLabelSummaryInput,
): Promise<{ rowCount: number }> {
  const labelDefinitions = await prisma.labelDefinition.findMany({ select: { id: true } })

  let rowCount = 0
  for (const labelDefinition of labelDefinitions) {
    const snapshots = await prisma.labelMetricSnapshot.findMany({
      where: { labelDefinitionId: labelDefinition.id },
      orderBy: [{ observedAt: 'desc' }],
      take: 8,
    })
    const latest = snapshots.at(0)
    if (!latest) continue

    const previous = snapshots.at(1)
    const dayAgo = snapshots.find(
      (snapshot) =>
        latest.observedAt.getTime() - snapshot.observedAt.getTime() >= 24 * 60 * 60 * 1000,
    )
    const weekAgo = snapshots.find(
      (snapshot) =>
        latest.observedAt.getTime() - snapshot.observedAt.getTime() >= 7 * 24 * 60 * 60 * 1000,
    )

    const activeFindings = await prisma.reviewFinding.findMany({
      where: {
        status: { in: ['active', 'recurring'] },
        primaryScopeType: 'label',
        primaryScopeId: labelDefinition.id,
      },
      select: { currentSeverity: true },
    })

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

    await prisma.labelSummaryCurrent.create({
      data: {
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
      },
    })
    rowCount++
  }

  return { rowCount }
}
