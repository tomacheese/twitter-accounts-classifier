import { Prisma, type PrismaClient } from '../../generated/prisma'
import { encodeCursor, decodeCursor } from '../pagination/keyset-cursor'

/** ReviewFinding のライフサイクル状態。 */
export type ReviewFindingStatus = 'active' | 'recurring' | 'resolved' | 'superseded'

/** Finding 一覧の絞り込み条件。 */
export interface ReviewFindingListFilters {
  status?: ReviewFindingStatus[]
  severity?: string[]
  type?: string
  primaryScopeType?: string
}

/** listReviewFindings の入力。 */
export interface ListReviewFindingsInput {
  filters: ReviewFindingListFilters
  cursor?: string | null
  limit: number
}

/** Finding 一覧の 1 行。 */
export interface ReviewFindingListItem {
  id: string
  type: string
  status: string
  currentSeverity: string
  primaryScopeType: string
  primaryScopeId: string
  firstDetectedAt: Date
  lastDetectedAt: Date
  recurrenceCount: number
}

/** listReviewFindings の返り値。 */
export interface ListReviewFindingsResult {
  items: ReviewFindingListItem[]
  nextCursor: string | null
}

const DEFAULT_STATUSES: ReviewFindingStatus[] = ['active', 'recurring']

// severity は文字列カラムのため、DB 側で数値順に比較できるよう CASE で rank へ変換する。
const SEVERITY_RANK_SQL = Prisma.sql`
  CASE "currentSeverity"
    WHEN 'critical' THEN 3
    WHEN 'high' THEN 2
    WHEN 'medium' THEN 1
    WHEN 'low' THEN 0
    ELSE -1
  END
`

/**
 * @param filters - status/severity/type/primaryScopeType の絞り込み条件
 * @returns filters の内容から決まる WHERE 句の断片
 */
function buildWhereFragment(filters: ReviewFindingListFilters): Prisma.Sql {
  const conditions: Prisma.Sql[] = []
  const statuses = filters.status ?? DEFAULT_STATUSES
  conditions.push(Prisma.sql`"status" = ANY(${statuses})`)
  if (filters.severity && filters.severity.length > 0) {
    conditions.push(Prisma.sql`"currentSeverity" = ANY(${filters.severity})`)
  }
  if (filters.type) {
    conditions.push(Prisma.sql`"type" = ${filters.type}`)
  }
  if (filters.primaryScopeType) {
    conditions.push(Prisma.sql`"primaryScopeType" = ${filters.primaryScopeType}`)
  }
  return Prisma.sql`${Prisma.join(conditions, ' AND ')}`
}

/**
 * filters を hash 化し、cursor に含める filterHash として使う。
 * filter が変わった cursor を誤って使い回さないようにする。
 * @param filters - 絞り込み条件
 * @returns 決定的な filterHash 文字列
 */
function hashFilters(filters: ReviewFindingListFilters): string {
  return JSON.stringify({
    status: [...(filters.status ?? DEFAULT_STATUSES)].toSorted(),
    severity: [...(filters.severity ?? [])].toSorted(),
    type: filters.type ?? null,
    primaryScopeType: filters.primaryScopeType ?? null,
  })
}

interface ReviewFindingRow {
  id: string
  type: string
  status: string
  currentSeverity: string
  primaryScopeType: string
  primaryScopeId: string
  firstDetectedAt: Date
  lastDetectedAt: Date
  recurrenceCount: number
  severityRank: number
}

/**
 * 表示ソート順は severity rank・lastDetectedAt・id の 3 キーに揃える。
 * affected ratio・affected count・duration は occurrence 側の値であり、
 * Finding 一覧クエリ単体では決定的な keyset 条件を組めない。
 * @param prisma - Prisma クライアント
 * @param input - filters・cursor・limit
 * @returns 1 ページ分の Finding 一覧と次ページの cursor
 */
export async function listReviewFindings(
  prisma: PrismaClient,
  input: ListReviewFindingsInput,
): Promise<ListReviewFindingsResult> {
  const filterHash = hashFilters(input.filters)
  const whereFragment = buildWhereFragment(input.filters)

  const cursorValues = input.cursor ? decodeCursor(input.cursor, filterHash) : null
  const cursorFragment = cursorValues
    ? Prisma.sql`AND (${SEVERITY_RANK_SQL}, "lastDetectedAt", "id") < (${Number(cursorValues[0])}, ${new Date(cursorValues[1] ?? '')}, ${cursorValues[2]})`
    : Prisma.empty

  const rows = await prisma.$queryRaw<ReviewFindingRow[]>`
    SELECT
      "id", "type", "status", "currentSeverity", "primaryScopeType", "primaryScopeId",
      "firstDetectedAt", "lastDetectedAt", "recurrenceCount",
      ${SEVERITY_RANK_SQL} AS "severityRank"
    FROM "ReviewFinding"
    WHERE ${whereFragment} ${cursorFragment}
    ORDER BY "severityRank" DESC, "lastDetectedAt" DESC, "id" DESC
    LIMIT ${input.limit + 1}
  `

  const hasMore = rows.length > input.limit
  const items = hasMore ? rows.slice(0, input.limit) : rows
  const last = items.at(-1)
  const nextCursor =
    hasMore && last
      ? encodeCursor({
          sortValues: [String(last.severityRank), last.lastDetectedAt.toISOString(), last.id],
          filterHash,
        })
      : null

  return {
    items: items.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      currentSeverity: row.currentSeverity,
      primaryScopeType: row.primaryScopeType,
      primaryScopeId: row.primaryScopeId,
      firstDetectedAt: row.firstDetectedAt,
      lastDetectedAt: row.lastDetectedAt,
      recurrenceCount: row.recurrenceCount,
    })),
    nextCursor,
  }
}
