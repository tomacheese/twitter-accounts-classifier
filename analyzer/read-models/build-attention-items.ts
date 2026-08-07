import type { Prisma, PrismaClient } from '../generated/prisma'

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }
const MAX_ITEMS = 8
// 異常に active な finding/issue が積み上がっても worker が全件ロードしないための上限。
const CANDIDATE_FETCH_LIMIT = MAX_ITEMS * 50

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
 * severity、recurring、affected ratio、affected count、firstDetectedAt の順で候補を並べる。
 * 必須性・critical フラグは OperationalIssue/ReviewFinding のどちらにも永続化されておらず、
 * severity と同値タイの範囲でしか意味を持たないため比較キーへ含めない。
 * 継続時間は firstDetectedAt の昇順と同順になるため独立した比較段を設けない。
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

  return a.firstDetectedAt.getTime() - b.firstDetectedAt.getTime()
}

/**
 * buildAttentionItems の入力。
 */
export interface BuildAttentionItemsInput {
  /** 書き込み先の generationId。 */
  generationId: string
  /** 集計の基準時刻。 */
  sourceWatermarkAt: Date
}

/**
 * OperationalIssue (active) と ReviewFinding (active/recurring) を統合し、
 * compareCandidates の優先順位で上位 MAX_ITEMS 件だけを AttentionItemCurrent へ書く。
 * 最終順位は全候補を突き合わせないと決まらないため、
 * 取得段では CANDIDATE_FETCH_LIMIT の上限だけを課し、厳密な絞り込みはメモリ上で行う。
 * @param prisma - Prisma クライアント
 * @param input - 対象 generationId と検索基準時刻
 * @returns 作成した行数
 */
export async function buildAttentionItems(
  prisma: PrismaClient,
  input: BuildAttentionItemsInput,
): Promise<{ rowCount: number }> {
  const [operationalIssues, reviewFindings] = await Promise.all([
    prisma.operationalIssue.findMany({
      where: { status: 'active' },
      orderBy: [{ firstDetectedAt: 'asc' }],
      take: CANDIDATE_FETCH_LIMIT,
    }),
    prisma.reviewFinding.findMany({
      where: { status: { in: ['active', 'recurring'] } },
      include: { occurrences: { orderBy: [{ observedAt: 'desc' }], take: 1 } },
      orderBy: [{ firstDetectedAt: 'asc' }],
      take: CANDIDATE_FETCH_LIMIT,
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
