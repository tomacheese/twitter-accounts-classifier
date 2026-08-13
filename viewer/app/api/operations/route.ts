import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { listOperationCycles, type OperationCycleKind } from '@/lib/queries/operation-cycles'
import { buildApiResponseMeta } from '@/lib/api-response'
import { getPipelineHealthBreakdown, getPipelineMeta } from '@/lib/read-model-meta'
import { guardSection } from '@/lib/api-section-guard'

const VALID_KINDS: OperationCycleKind[] = ['crawl', 'weekly_review', 'block']

/**
 * @param request - `kind`/`attentionRequired`/`cursor` クエリパラメータを持つリクエスト
 * @returns Operations 一覧レスポンス
 */
export async function GET(request: Request): Promise<NextResponse> {
  const denied = guardSection('operations')
  if (denied) return denied

  const { searchParams } = new URL(request.url)
  const kindParam = searchParams.get('kind')
  const kind = (VALID_KINDS as string[]).includes(kindParam ?? '')
    ? (kindParam as OperationCycleKind)
    : undefined
  const attentionRequired = searchParams.get('attentionRequired') === 'true'
  const cursor = searchParams.get('cursor') ?? undefined

  const prisma = getPrismaClient()
  const { items, nextCursor } = await listOperationCycles(prisma, {
    filters: { kind, attentionRequired },
    cursor,
  })
  const [meta, pipelineHealth] = await Promise.all([
    getPipelineMeta(prisma),
    getPipelineHealthBreakdown(prisma),
  ])

  return NextResponse.json(
    { items, meta: buildApiResponseMeta({ ...meta, nextCursor, pipelineHealth }) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
