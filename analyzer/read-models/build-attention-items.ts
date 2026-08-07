import type { Prisma, PrismaClient } from '../generated/prisma'

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }
const MAX_ITEMS = 8

interface AttentionCandidate {
  sourceType: string
  sourceId: string
  category: string
  severity: string
  isRecurring: boolean
  affectedRatio: number
  affectedCount: number
  firstDetectedAt: Date
  summary: string
  impact: Record<string, unknown>
  freshness: string
  detailHref: string
}

/**
 * spec の複合優先順位 (severity → recurring → affected ratio → affected count →
 * 継続時間 → detectedAt) で候補を並べる。必須性・critical フラグは
 * OperationalIssue/ReviewFinding のどちらにも永続化されていないため、
 * この 2 段は severity と同値タイの範囲でしか意味を持たず、比較キーへ含めない。
 * @param a - 比較対象の候補
 * @param b - 比較対象の候補
 * @returns 並び替え用の比較値
 */
function compareCandidates(a: AttentionCandidate, b: AttentionCandidate): number {
  const severityDiff = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
  if (severityDiff !== 0) return severityDiff

  const recurringDiff = Number(b.isRecurring) - Number(a.isRecurring)
  if (recurringDiff !== 0) return recurringDiff

  const ratioDiff = b.affectedRatio - a.affectedRatio
  if (ratioDiff !== 0) return ratioDiff

  const countDiff = b.affectedCount - a.affectedCount
  if (countDiff !== 0) return countDiff

  const durationDiff = a.firstDetectedAt.getTime() - b.firstDetectedAt.getTime()
  if (durationDiff !== 0) return durationDiff

  return a.firstDetectedAt.getTime() - b.firstDetectedAt.getTime()
}

export interface BuildAttentionItemsInput {
  generationId: string
  sourceWatermarkAt: Date
}

/**
 * OperationalIssue (active) と ReviewFinding (active/recurring) を統合し、
 * spec が定める複合優先順位で上位 8 件だけを AttentionItemCurrent へ書く。
 * @param prisma - Prisma クライアント
 * @param input - 対象 generationId と検索基準時刻
 * @returns 作成した行数
 */
export async function buildAttentionItems(
  prisma: PrismaClient,
  input: BuildAttentionItemsInput,
): Promise<{ rowCount: number }> {
  const [operationalIssues, reviewFindings] = await Promise.all([
    prisma.operationalIssue.findMany({ where: { status: 'active' } }),
    prisma.reviewFinding.findMany({
      where: { status: { in: ['active', 'recurring'] } },
      include: { occurrences: { orderBy: [{ observedAt: 'desc' }], take: 1 } },
    }),
  ])

  const candidates: AttentionCandidate[] = [
    ...operationalIssues.map((issue): AttentionCandidate => {
      return {
        sourceType: 'operational_issue',
        sourceId: issue.id,
        category: issue.type,
        severity: issue.severity,
        isRecurring: false,
        affectedRatio: 0,
        affectedCount: 0,
        firstDetectedAt: issue.firstDetectedAt,
        summary: `${issue.component}: ${issue.type}`,
        impact: {},
        freshness: 'current',
        detailHref: `/operations/issues/${issue.id}`,
      }
    }),
    ...reviewFindings.map((finding): AttentionCandidate => {
      const latestOccurrence = finding.occurrences.at(0)
      const totalCount = latestOccurrence?.totalCount ?? 0
      const affectedCount = latestOccurrence?.affectedCount ?? 0
      return {
        sourceType: 'review_finding',
        sourceId: finding.id,
        category: finding.type,
        severity: finding.currentSeverity,
        isRecurring: finding.status === 'recurring',
        affectedRatio: totalCount > 0 ? affectedCount / totalCount : 0,
        affectedCount,
        firstDetectedAt: finding.firstDetectedAt,
        summary: `${finding.type} (${finding.primaryScopeType}:${finding.primaryScopeId})`,
        impact: { affectedCount, totalCount },
        freshness: 'current',
        detailHref: `/review/findings/${finding.id}`,
      }
    }),
  ]

  const topCandidates = candidates.toSorted(compareCandidates).slice(0, MAX_ITEMS)

  await prisma.attentionItemCurrent.createMany({
    data: topCandidates.map((candidate, index) => ({
      generationId: input.generationId,
      sourceType: candidate.sourceType,
      sourceId: candidate.sourceId,
      category: candidate.category,
      priority: index + 1,
      severity: candidate.severity,
      summary: candidate.summary,
      impact: candidate.impact as Prisma.InputJsonValue,
      detectedAt: candidate.firstDetectedAt,
      freshness: candidate.freshness,
      detailHref: candidate.detailHref,
    })),
  })

  return { rowCount: topCandidates.length }
}
