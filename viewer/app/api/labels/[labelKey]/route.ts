import { NextRequest, NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { getLabelDetail, type LabelDetailRangePreset } from '@/lib/queries/label-detail'

interface RouteParams {
  params: Promise<{ labelKey: string }>
}

const RANGE_PRESETS: LabelDetailRangePreset[] = ['24h', '7d', '30d', '90d']

/**
 * @param value - 生の検索パラメータの値
 * @returns サポートされている期間 preset であれば true
 */
function isRangePreset(value: string | null): value is LabelDetailRangePreset {
  return !!value && (RANGE_PRESETS as string[]).includes(value)
}

/**
 * 期間 preset を切り替えたときの Trend 再取得用 Route Handler。
 * @param request - Next.js の Route Handler request
 * @param context - route params (`labelKey`)
 * @returns Label 詳細。存在しなければ 404
 */
export async function GET(request: NextRequest, context: RouteParams): Promise<NextResponse> {
  const { labelKey } = await context.params
  const rangeParam = request.nextUrl.searchParams.get('range')
  const range = isRangePreset(rangeParam) ? rangeParam : undefined

  const prisma = getPrismaClient()
  const detail = await getLabelDetail(prisma, labelKey, { range })

  if (!detail) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }

  return NextResponse.json({ detail }, { headers: { 'Cache-Control': 'no-store' } })
}
