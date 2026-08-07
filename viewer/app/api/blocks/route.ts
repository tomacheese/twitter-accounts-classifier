import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { listBlockRelations } from '@/lib/queries/block-relations'

/**
 * @param request - `status`/`cursor` クエリパラメータを持つリクエスト
 * @returns Blocks 一覧レスポンス
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status') ?? undefined
  const cursor = searchParams.get('cursor') ?? undefined

  const prisma = getPrismaClient()
  const { items, nextCursor } = await listBlockRelations(prisma, {
    filters: { status },
    cursor,
  })

  return NextResponse.json({ items, nextCursor }, { headers: { 'Cache-Control': 'no-store' } })
}
