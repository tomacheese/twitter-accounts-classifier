import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { getReviewFindingDetail } from '@/lib/queries/review-finding-detail'
import { guardSection } from '@/lib/api-section-guard'

interface RouteParams {
  params: Promise<{ findingId: string }>
}

/**
 * Finding 詳細ページの初期表示には含めない Occurrence 追加分を遅延取得する。
 * @param _request - 未使用 (query string を使わないため)
 * @param context - route params (`findingId`)
 * @returns Occurrence 一覧、Finding が存在しなければ 404
 */
export async function GET(_request: Request, context: RouteParams): Promise<NextResponse> {
  const denied = guardSection('review')
  if (denied) return denied

  const { findingId } = await context.params
  const prisma = getPrismaClient()
  const detail = await getReviewFindingDetail(prisma, findingId)

  if (!detail) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  return NextResponse.json(
    { occurrences: detail.occurrences },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
