import { NextResponse } from 'next/server'
import { getPrismaClient } from '../../../lib/prisma'
import { getOverviewSnapshot } from '../../../lib/queries/overview'
import { buildApiResponseMeta } from '../../../lib/api-response'

/**
 * Operational Health / Classification Quality / Attention Queue / Latest Pipeline を
 * まとめて返す。current health・Attention・running Cycle は process-local cache を
 * 正本にしないため (spec の cache 方針)、常に `Cache-Control: no-store` を返す。
 * ポーリング間隔自体はクライアント側で制御する。
 * @returns Overview 画面向けのレスポンス
 */
export async function GET(): Promise<NextResponse> {
  const prisma = getPrismaClient()
  const snapshot = await getOverviewSnapshot(prisma)
  const generatedAt = new Date()

  const body = snapshot
    ? {
        operationalStatus: snapshot.operationalStatus,
        qualityStatus: snapshot.qualityStatus,
        attention: snapshot.attention,
        latestPipeline: snapshot.latestPipeline,
        meta: buildApiResponseMeta({
          generatedAt,
          sourceDataAt: snapshot.sourceDataAt,
          generationId: snapshot.generationId,
          policyHash: snapshot.policyHash,
          freshnessStatus: snapshot.freshnessStatus,
        }),
      }
    : {
        operationalStatus: 'unknown',
        qualityStatus: 'unknown',
        attention: [],
        latestPipeline: null,
        meta: buildApiResponseMeta({
          generatedAt,
          sourceDataAt: null,
          generationId: null,
          policyHash: null,
          freshnessStatus: 'unknown',
        }),
      }

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
