import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { listLabelSummaries } from '@/lib/queries/label-summary'
import { buildApiResponseMeta } from '@/lib/api-response'
import { getReadModelMeta } from '@/lib/read-model-meta'
import { guardSection } from '@/lib/api-section-guard'

/**
 * @returns Labels 一覧レスポンス
 */
export async function GET(): Promise<NextResponse> {
  const denied = guardSection('labels')
  if (denied) return denied

  const prisma = getPrismaClient()
  const items = await listLabelSummaries(prisma)
  const meta = await getReadModelMeta(prisma, 'label_summary')

  return NextResponse.json(
    { items, meta: buildApiResponseMeta(meta) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
