import { NextResponse } from 'next/server'
import { getPrismaClient } from '../../../lib/prisma'
import { getOverviewSnapshot } from '../../../lib/queries/overview'
import { buildApiResponseMeta } from '../../../lib/api-response'
import { getPipelineHealthBreakdown, getReadModelMeta } from '../../../lib/read-model-meta'
import { guardSection } from '../../../lib/api-section-guard'

/**
 * Overview 画面が必要とする各セクションをまとめて返す。
 * current health・Attention・running Cycle は process-local cache を正本にしないため、
 * 常に `Cache-Control: no-store` を返す。
 * ポーリング間隔自体はクライアント側で制御する。
 * @returns Overview 画面向けのレスポンス
 */
export async function GET(): Promise<NextResponse> {
  const denied = guardSection('overview')
  if (denied) return denied

  const prisma = getPrismaClient()
  const snapshot = await getOverviewSnapshot(prisma)
  const [{ generatedAt }, pipelineHealth] = await Promise.all([
    getReadModelMeta(prisma, 'overview_snapshot'),
    getPipelineHealthBreakdown(prisma),
  ])

  const body = snapshot
    ? {
        operationalStatus: snapshot.operationalStatus,
        qualityStatus: snapshot.qualityStatus,
        attention: snapshot.attention,
        latestPipeline: snapshot.latestPipeline,
        coreFreshnessStatus: snapshot.coreFreshnessStatus,
        corePerModel: snapshot.corePerModel,
        coreFreshnessDivergesFromSnapshot: snapshot.coreFreshnessDivergesFromSnapshot,
        meta: buildApiResponseMeta({
          generatedAt,
          sourceDataAt: snapshot.sourceDataAt,
          generationId: snapshot.generationId,
          policyHash: snapshot.policyHash,
          freshnessStatus: snapshot.freshnessStatus,
          pipelineHealth,
        }),
      }
    : {
        operationalStatus: 'unknown',
        qualityStatus: 'unknown',
        attention: [],
        latestPipeline: null,
        coreFreshnessStatus: 'unknown' as const,
        corePerModel: [],
        coreFreshnessDivergesFromSnapshot: false,
        meta: buildApiResponseMeta({
          generatedAt,
          sourceDataAt: null,
          generationId: null,
          policyHash: null,
          freshnessStatus: 'unknown',
          pipelineHealth,
        }),
      }

  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}
