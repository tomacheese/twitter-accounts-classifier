import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import {
  getAccountClassification,
  getAccountEvidence,
  getAccountHistory,
  getAccountOverview,
  getAccountRelations,
  getAccountTechnical,
} from '@/lib/queries/account-subviews'

interface RouteParams {
  params: Promise<{ accountId: string; subview: string }>
}

const SUBVIEW_HANDLERS = {
  overview: getAccountOverview,
  classification: getAccountClassification,
  evidence: getAccountEvidence,
  relations: getAccountRelations,
  history: getAccountHistory,
  technical: getAccountTechnical,
} as const

type SubviewKey = keyof typeof SUBVIEW_HANDLERS

/**
 * @param value - 生の subview パスパラメータ
 * @returns サポートされている subview かどうか
 */
function isSubviewKey(value: string): value is SubviewKey {
  // `in` は Object.prototype 由来の `toString` などにも真を返し、
  // handler が任意の prototype メソッドに束縛されてしまう。
  return Object.hasOwn(SUBVIEW_HANDLERS, value)
}

/**
 * `overview` 以外の subview を tab 切り替え時に遅延取得するための Route Handler。
 * @param _request - 未使用 (query string を使わないため)
 * @param context - route params (`accountId`, `subview`)
 * @returns subview のデータ。未知の subview なら 400、対象が存在しなければ 404
 */
export async function GET(_request: Request, context: RouteParams): Promise<NextResponse> {
  const { accountId, subview } = await context.params
  if (!isSubviewKey(subview)) {
    return NextResponse.json({ error: 'unknown subview' }, { status: 400 })
  }

  const prisma = getPrismaClient()
  const handler = SUBVIEW_HANDLERS[subview]
  const data = await handler(prisma, accountId)
  if (data === null) {
    return NextResponse.json({ error: 'account not found' }, { status: 404 })
  }

  return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
}
