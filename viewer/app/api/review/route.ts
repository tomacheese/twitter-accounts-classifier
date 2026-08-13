import { NextRequest, NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import {
  listReviewFindings,
  type ReviewFindingListFilters,
  type ReviewFindingStatus,
} from '@/lib/queries/review-findings'
import { buildApiResponseMeta } from '@/lib/api-response'
import { getPipelineHealthBreakdown, getPipelineMeta } from '@/lib/read-model-meta'
import { guardSection } from '@/lib/api-section-guard'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

const VALID_STATUSES: ReviewFindingStatus[] = ['active', 'recurring', 'resolved', 'superseded']

/**
 * @param value - 生の status パラメータの値
 * @returns サポートされている status であれば true
 */
function isReviewFindingStatus(value: string): value is ReviewFindingStatus {
  return (VALID_STATUSES as string[]).includes(value)
}

/**
 * @param status - カンマ区切りの status パラメータ
 * @returns 既知の status のみを残した配列。1 つも残らなければ undefined (既定 filter に委ねる)
 */
function parseStatuses(status: string | null): ReviewFindingStatus[] | undefined {
  if (!status) return undefined
  const parsed = status.split(',').filter((value) => isReviewFindingStatus(value))
  return parsed.length > 0 ? parsed : undefined
}

/**
 * @param searchParams - リクエストの query string
 * @returns listReviewFindings 向けに変換した filters
 */
function parseFilters(searchParams: URLSearchParams): ReviewFindingListFilters {
  const severity = searchParams.get('severity')
  return {
    status: parseStatuses(searchParams.get('status')),
    severity: severity ? severity.split(',') : undefined,
    type: searchParams.get('type') ?? undefined,
    primaryScopeType: searchParams.get('primaryScopeType') ?? undefined,
  }
}

/**
 * Quality Review 一覧を keyset pagination で返す。
 * @param request - Next.js の Route Handler request
 * @returns Finding 一覧レスポンス
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = guardSection('review')
  if (denied) return denied

  const { searchParams } = request.nextUrl
  const filters = parseFilters(searchParams)
  const cursor = searchParams.get('cursor')
  const limitParam = Number(searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit =
    Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT

  const prisma = getPrismaClient()
  const result = await listReviewFindings(prisma, { filters, cursor, limit })
  const [meta, pipelineHealth] = await Promise.all([
    getPipelineMeta(prisma),
    getPipelineHealthBreakdown(prisma),
  ])

  return NextResponse.json(
    {
      items: result.items,
      meta: buildApiResponseMeta({ ...meta, nextCursor: result.nextCursor, pipelineHealth }),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
