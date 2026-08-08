import { NextResponse } from 'next/server'
import { getPrismaClient } from '@/lib/prisma'
import { guardSection } from '@/lib/api-section-guard'

/**
 * Active policy の生設定を返す。System 画面では初期折りたたみとし、
 * 展開時にのみこのエンドポイントから取得する。
 * @returns 最新 DetectionPolicyVersion の生設定
 */
export async function GET(): Promise<NextResponse> {
  const denied = guardSection('system')
  if (denied) return denied

  const prisma = getPrismaClient()
  const latest = await prisma.detectionPolicyVersion.findFirst({
    orderBy: [{ loadedAt: 'desc' }],
  })

  if (!latest) {
    return NextResponse.json({ content: null }, { headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json(
    { content: latest.content },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
