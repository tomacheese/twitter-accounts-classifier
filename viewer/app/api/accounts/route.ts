import { NextRequest, NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { listAccountSummaries, type AccountSummaryView } from '@/lib/queries/account-summary'
import { buildApiResponseMeta } from '@/lib/api-response'
import { getReadModelMeta } from '@/lib/read-model-meta'
import { guardSection } from '@/lib/api-section-guard'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100

/**
 * @param request - Next.js の Route Handler request
 * @returns Accounts 一覧レスポンス
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const denied = guardSection('accounts')
  if (denied) return denied

  const { searchParams } = request.nextUrl
  const view: AccountSummaryView = searchParams.get('view') === 'all' ? 'all' : 'recentlyChanged'
  const labelKeysParam = searchParams.get('labelKeys')
  const minFindingSeverity = searchParams.get('minFindingSeverity')
  const limitParam = Number(searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit =
    Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT

  const prisma = getPrismaClient()
  const result = await listAccountSummaries(prisma, {
    view,
    filters: {
      ...(labelKeysParam ? { labelKeys: labelKeysParam.split(',') } : {}),
      ...(minFindingSeverity ? { minFindingSeverity } : {}),
    },
    cursor: searchParams.get('cursor'),
    limit,
  })
  const meta = await getReadModelMeta(prisma, 'account_summary')

  return NextResponse.json(
    {
      items: result.items,
      meta: buildApiResponseMeta({
        ...meta,
        generationId: result.generationId,
        freshnessStatus: result.freshnessStatus,
        nextCursor: result.nextCursor,
      }),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
