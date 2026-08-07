import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { listOperationCycles, type OperationCycleKind } from '@/lib/queries/operation-cycles'

const VALID_KINDS: OperationCycleKind[] = ['crawl', 'weekly_review', 'block']

/**
 * @param request - `kind`/`attentionRequired` クエリパラメータを持つリクエスト
 * @returns Operations 一覧レスポンス
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const kindParam = searchParams.get('kind')
  const kind = (VALID_KINDS as string[]).includes(kindParam ?? '')
    ? (kindParam as OperationCycleKind)
    : undefined
  const attentionRequired = searchParams.get('attentionRequired') === 'true'

  const prisma = getPrismaClient()
  const items = await listOperationCycles(prisma, { filters: { kind, attentionRequired } })

  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } })
}
