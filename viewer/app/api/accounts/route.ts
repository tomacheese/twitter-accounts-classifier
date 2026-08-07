import { NextRequest, NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { listAccountSummaries, type AccountSummaryView } from '@/lib/queries/account-summary'
import { buildApiResponseMeta } from '@/lib/api-response'

/**
 * @param request - Next.js の Route Handler request
 * @returns Accounts 一覧レスポンス
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl
  const view: AccountSummaryView = searchParams.get('view') === 'all' ? 'all' : 'recentlyChanged'
  const labelKeysParam = searchParams.get('labelKeys')

  const prisma = getPrismaClient()
  const result = await listAccountSummaries(prisma, {
    view,
    filters: labelKeysParam ? { labelKeys: labelKeysParam.split(',') } : undefined,
  })

  return NextResponse.json(
    {
      items: result.items,
      meta: buildApiResponseMeta({
        generatedAt: new Date(),
        sourceDataAt: null,
        generationId: result.generationId,
        policyHash: null,
        freshnessStatus: result.generationId ? 'healthy' : 'unknown',
      }),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
