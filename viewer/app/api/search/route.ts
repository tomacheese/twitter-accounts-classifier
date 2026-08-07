import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { searchAcrossEntities } from '@/lib/queries/global-search'

/**
 * @param request - `q` クエリパラメータを持つリクエスト
 * @returns Global Search 結果レスポンス
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q') ?? ''

  const prisma = getPrismaClient()
  const result = await searchAcrossEntities(prisma, { query })

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
