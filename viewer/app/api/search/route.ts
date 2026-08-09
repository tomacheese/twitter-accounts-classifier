import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { searchAcrossEntities } from '@/lib/queries/global-search'
import { isNewUiSectionEnabled } from '@/lib/feature-flags'

/**
 * ログ集約基盤が制御文字を行区切りとして解釈する可能性があるため、ログに渡す前に除去し長さを制限する。
 * @param query - ユーザーが入力した検索文字列
 * @returns 制御文字を除いた先頭 100 文字
 */
function sanitizeForLog(query: string): string {
  let sanitized = ''
  for (const char of query) {
    const codePoint = char.codePointAt(0) ?? 0
    if (codePoint >= 0x20 && codePoint !== 0x7f) {
      sanitized += char
    }
  }
  return sanitized.slice(0, 100)
}

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

  console.info('Global search completed:', {
    query: sanitizeForLog(query),
    timingMs: result.timingMs,
  })

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
