import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { listLabelSummaries } from '@/lib/queries/label-summary'

/**
 * @returns Labels 一覧レスポンス
 */
export async function GET(): Promise<NextResponse> {
  const prisma = getPrismaClient()
  const items = await listLabelSummaries(prisma)

  return NextResponse.json({ items }, { headers: { 'Cache-Control': 'no-store' } })
}
