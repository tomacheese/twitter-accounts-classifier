import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { searchAcrossEntities } from '@/lib/queries/global-search'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'

/**
 * @param request - `q` クエリパラメータを持つリクエスト
 * @returns Global Search 結果レスポンス。無効な区画の entity type は空配列になる
 */
export async function GET(request: Request): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)
  const query = searchParams.get('q') ?? ''

  const prisma = getPrismaClient()
  const result = await searchAcrossEntities(prisma, {
    query,
    enabledEntityTypes: {
      accounts: isNewUiSectionEnabled('accounts'),
      labels: isNewUiSectionEnabled('labels'),
      findings: isNewUiSectionEnabled('review'),
      operations: isNewUiSectionEnabled('operations'),
    },
  })

  console.info('Global search completed:', { query, timingMs: result.timingMs })

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
