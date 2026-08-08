import type { Prisma, PrismaClient } from '../generated/prisma'

const SEVERITY_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 }
const MAX_ITEMS = 8
// 深刻な順に評価する。低い severity の滞留で critical が取得段から溢れないようにするため。
const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low']
// 異常に active な finding/issue が積み上がっても worker が全件ロードしないための上限。
// 同じ severity 内では継続期間が長いものを優先して残す。
const PER_SEVERITY_FETCH_LIMIT = MAX_ITEMS * 25

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

interface ReviewFindingCandidateRow {
  id: string
  type: string
  status: string
  currentSeverity: string
  primaryScopeType: string
  primaryScopeId: string
  firstDetectedAt: Date
  affectedCount: number | null
  totalCount: number | null
}

/**
 * 指定 severity の ReviewFinding 候補を、最終 comparator (recurring → affectedRatio →
 * affectedCount → firstDetectedAt) と同じ優先順位で DB 側から取得する。
 * この優先順位は affectedCount/totalCount という Occurrence 側の値から
 * 都度算出する必要があり、Prisma の `orderBy` では表現できないため raw SQL を使う。
 * アプリ側で全件取得してから並べ替えると、severity 内の件数が LIMIT を超えたときに
 * 本来 top 8 に入るべき候補を取得段で落としてしまう。
 * @param prisma - Prisma クライアント
 * @param severity - 対象の severity
 * @returns 優先順位順に並んだ候補一覧 (最大 PER_SEVERITY_FETCH_LIMIT 件)
 */
async function fetchReviewFindingCandidatesForSeverity(
  prisma: PrismaClient,
  severity: string,
): Promise<ReviewFindingCandidateRow[]> {
  return prisma.$queryRaw<ReviewFindingCandidateRow[]>`
    SELECT
      rf."id",
      rf."type",
      rf."status",
      rf."currentSeverity",
      rf."primaryScopeType",
      rf."primaryScopeId",
      rf."firstDetectedAt",
      latest."affectedCount",
      latest."totalCount"
    FROM "ReviewFinding" rf
    LEFT JOIN LATERAL (
      SELECT "affectedCount", "totalCount"
      FROM "ReviewFindingOccurrence"
      WHERE "findingId" = rf."id"
      ORDER BY "observedAt" DESC, "id" DESC
      LIMIT 1
    ) latest ON true
    WHERE rf."status" IN ('active', 'recurring') AND rf."currentSeverity" = ${severity}
    ORDER BY
      (rf."status" = 'recurring') DESC,
      CASE
        WHEN COALESCE(latest."totalCount", 0) > 0
          THEN latest."affectedCount"::float / latest."totalCount"
        ELSE 0
      END DESC,
      COALESCE(latest."affectedCount", 0) DESC,
      rf."firstDetectedAt" ASC
    LIMIT ${PER_SEVERITY_FETCH_LIMIT}
  `
}

/**
 * 指定 severity の候補だけを取得する。
 * @param prisma - Prisma クライアント
 * @param severity - 対象の severity
 * @returns その severity の候補一覧
 */
async function fetchCandidatesForSeverity(
  prisma: PrismaClient,
  severity: string,
): Promise<AttentionCandidate[]> {
  const [operationalIssues, reviewFindings] = await Promise.all([
    prisma.operationalIssue.findMany({
      where: { status: 'active', severity },
      orderBy: [{ firstDetectedAt: 'asc' }],
      take: PER_SEVERITY_FETCH_LIMIT,
    }),
    fetchReviewFindingCandidatesForSeverity(prisma, severity),
  ])

  return [
    ...operationalIssues.map((issue): AttentionCandidate => ({
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
    })),
    ...reviewFindings.map((finding): AttentionCandidate => {
      const totalCount = finding.totalCount ?? 0
      const affectedCount = finding.affectedCount ?? 0
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
}

/**
 * OperationalIssue (active) と ReviewFinding (active/recurring) を統合し、
 * compareCandidates の優先順位で上位 MAX_ITEMS 件だけを AttentionItemCurrent へ書く。
 * compareCandidates は severity を最優先で比較するため、
 * 深刻な severity から順に取得し MAX_ITEMS を満たした時点で打ち切れば、
 * それより低い severity は結果に入り得ない。
 * @param prisma - Prisma クライアント
 * @param input - 対象 generationId と検索基準時刻
 * @returns 作成した行数
 */
export async function buildAttentionItems(
  prisma: PrismaClient,
  input: BuildAttentionItemsInput,
): Promise<{ rowCount: number }> {
  const candidates: AttentionCandidate[] = []
  for (const severity of SEVERITY_ORDER) {
    candidates.push(...(await fetchCandidatesForSeverity(prisma, severity)))
    if (candidates.length >= MAX_ITEMS) break
  }

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
