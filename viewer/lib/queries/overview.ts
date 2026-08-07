import type { PrismaClient } from '../../generated/prisma'
import type { ReadModelFreshnessStatus } from '../api-response'

export interface AttentionItemView {
  sourceType: string
  sourceId: string
  category: string
  severity: string
  summary: string
  detailHref: string
}

export interface LatestPipelineStageView {
  stageKey: string
  status: string
}

export interface LatestPipelineView {
  cycleId: string
  status: string
  stages: LatestPipelineStageView[]
}

export interface OverviewSnapshotView {
  operationalStatus: string
  qualityStatus: string
  attention: AttentionItemView[]
  latestPipeline: LatestPipelineView | null
  sourceDataAt: Date | null
  generationId: string | null
  policyHash: string | null
  freshnessStatus: ReadModelFreshnessStatus
}

const MODEL_KEY = 'overview_snapshot'

/**
 * OverviewSnapshot の payload は build-overview-snapshot.ts が書いた形をそのまま信頼する。
 * ここでは実行時に壊れた値が渡っても画面全体を落とさないよう、最小限の形だけ検証する。
 * @param payload - OverviewSnapshot.payload (Json)
 * @returns attention と latestPipeline
 */
function parsePayload(payload: unknown): {
  attention: AttentionItemView[]
  latestPipeline: LatestPipelineView | null
} {
  if (typeof payload !== 'object' || payload === null) {
    return { attention: [], latestPipeline: null }
  }
  const record = payload as Record<string, unknown>
  const attention = Array.isArray(record.attention) ? (record.attention as AttentionItemView[]) : []
  const latestPipeline =
    typeof record.latestPipeline === 'object' && record.latestPipeline !== null
      ? (record.latestPipeline as LatestPipelineView)
      : null
  return { attention, latestPipeline }
}

/**
 * 最新の OverviewSnapshot を取得し、ReadModelState(modelKey: 'overview_snapshot') の
 * status を freshnessStatus として重ねる。ReadModelState が stale/failed でも、
 * 直近成功した OverviewSnapshot の内容自体は消さずに返す。
 * @param prisma - Prisma クライアント
 * @returns 表示に必要な Overview の内容。OverviewSnapshot が 1 件も無ければ null
 */
export async function getOverviewSnapshot(
  prisma: PrismaClient,
): Promise<OverviewSnapshotView | null> {
  const [snapshot, readModelState] = await Promise.all([
    prisma.overviewSnapshot.findFirst({ orderBy: [{ sourceWatermarkAt: 'desc' }] }),
    prisma.readModelState.findUnique({ where: { modelKey: MODEL_KEY } }),
  ])

  if (!snapshot) return null

  const { attention, latestPipeline } = parsePayload(snapshot.payload)
  const freshnessStatus: ReadModelFreshnessStatus =
    readModelState?.status === 'healthy' ||
    readModelState?.status === 'stale' ||
    readModelState?.status === 'failed'
      ? readModelState.status
      : 'unknown'

  return {
    operationalStatus: snapshot.operationalStatus,
    qualityStatus: snapshot.qualityStatus,
    attention,
    latestPipeline,
    sourceDataAt: snapshot.sourceWatermarkAt,
    generationId: readModelState?.currentGenerationId ?? null,
    policyHash: readModelState?.policyHash ?? null,
    freshnessStatus,
  }
}
