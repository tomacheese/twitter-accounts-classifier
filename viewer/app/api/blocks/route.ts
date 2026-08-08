import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { listBlockRelations } from '@/lib/queries/block-relations'
import { buildApiResponseMeta } from '@/lib/api-response'
import { getReadModelMeta } from '@/lib/read-model-meta'
import { guardSection } from '@/lib/api-section-guard'

/**
 * @param request - `status`/`cursor` クエリパラメータを持つリクエスト
 * @returns Blocks 一覧レスポンス
 */
export async function GET(request: Request): Promise<NextResponse> {
  const denied = guardSection('blocks')
  if (denied) return denied

  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') ?? undefined
  const cursor = searchParams.get('cursor') ?? undefined

  const prisma = getPrismaClient()
  const { items, nextCursor, generationId } = await listBlockRelations(prisma, {
    filters: { status },
    cursor,
  })
  const meta = await getReadModelMeta(prisma, 'block_relation')

  return NextResponse.json(
    {
      items,
      meta: buildApiResponseMeta({ ...meta, generationId, nextCursor }),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
