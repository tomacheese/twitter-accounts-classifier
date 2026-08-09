import type { PrismaClient } from '../../generated/prisma'
import type { ReadModelFreshnessStatus } from '../api-response'
import {
  getCoreReadModelMeta,
  getFreshnessThresholds,
  overlayHealthWithFreshness,
  reconcileFreshness,
  toFreshnessStatus,
  type CoreReadModelStatus,
} from '../read-model-meta'

/** Attention Queue の 1 件。 */
export interface AttentionItemView {
  sourceType: string
  sourceId: string
  category: string
  severity: string
  summary: string
  detailHref: string
}

/** 直近パイプラインの Stage 1 件。 */
export interface LatestPipelineStageView {
  stageKey: string
  status: string
}

/** 直近パイプラインの実行状況。 */
export interface LatestPipelineView {
  cycleId: string
  status: string
  stages: LatestPipelineStageView[]
}

/** Overview 画面の表示内容。 */
export interface OverviewSnapshotView {
  operationalStatus: string
  qualityStatus: string
  attention: AttentionItemView[]
  latestPipeline: LatestPipelineView | null
  sourceDataAt: Date | null
  generationId: string | null
  policyHash: string | null
  freshnessStatus: ReadModelFreshnessStatus
  coreFreshnessStatus: ReadModelFreshnessStatus
  corePerModel: CoreReadModelStatus[]
  coreFreshnessDivergesFromSnapshot: boolean
}

const MODEL_KEY = 'overview_snapshot'

/**
 * @param value - 検証対象の値
 * @param keys - 文字列であることを要求するプロパティ名
 * @returns すべてのプロパティが文字列を持つオブジェクトであれば true
 */
function hasStringProps<K extends string>(
  value: unknown,
  keys: readonly K[],
): value is Record<K, string> {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return keys.every((key) => typeof record[key] === 'string')
}

const ATTENTION_ITEM_KEYS = [
  'sourceType',
  'sourceId',
  'category',
  'severity',
  'summary',
  'detailHref',
] as const

/**
 * OverviewSnapshot の payload は Json 列であり、型は実行時に保証されない。
 * 壊れた行が 1 件混ざっても画面全体を落とさないよう、
 * 表示に使うプロパティが揃っている要素だけを通す。
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
  const attention = Array.isArray(record.attention)
    ? record.attention.filter((item): item is AttentionItemView =>
        hasStringProps(item, ATTENTION_ITEM_KEYS),
      )
    : []

  const rawPipeline = record.latestPipeline
  let latestPipeline: LatestPipelineView | null = null
  if (hasStringProps(rawPipeline, ['cycleId', 'status'])) {
    const rawStages = (rawPipeline as unknown as Record<string, unknown>).stages
    latestPipeline = {
      cycleId: rawPipeline.cycleId,
      status: rawPipeline.status,
      stages: Array.isArray(rawStages)
        ? rawStages.filter((stage): stage is LatestPipelineStageView =>
            hasStringProps(stage, ['stageKey', 'status']),
          )
        : [],
    }
  }

  return { attention, latestPipeline }
}

/**
 * 現在公開中の OverviewSnapshot を取得し、
 * ReadModelState の status を freshnessStatus として重ねる。
 * ReadModelState が stale・failed でも、直近成功した内容自体は消さずに返す。
 * generatedAt DESC ではなく ReadModelState.currentGenerationId を経由して取得することで、
 * build 中の snapshot が INSERT 済みでも Pointer 未切り替えの間は表示しない
 * (publishGeneration の原子的公開の保証と揃える)。
 * @param prisma - Prisma クライアント
 * @returns 表示に必要な Overview の内容。current generation の OverviewSnapshot が無ければ null
 */
export async function getOverviewSnapshot(
  prisma: PrismaClient,
): Promise<OverviewSnapshotView | null> {
  const readModelState = await prisma.readModelState.findUnique({ where: { modelKey: MODEL_KEY } })
  if (!readModelState?.currentGenerationId) return null

  const snapshot = await prisma.overviewSnapshot.findUnique({
    where: { generationId: readModelState.currentGenerationId },
  })

  if (!snapshot) return null

  const { attention, latestPipeline } = parsePayload(snapshot.payload)
  // status を直接 map するだけだと analyzer 停止で DB の status が固定された後も
  // 経過時間で stale に落とせない。共通の read-model-meta と同じ再評価を通す。
  const thresholds = await getFreshnessThresholds(prisma)
  const freshnessStatus: ReadModelFreshnessStatus = reconcileFreshness(
    toFreshnessStatus(readModelState.status),
    readModelState.lastSuccessAt,
    thresholds,
    new Date(),
  )

  const { operationalStatus, qualityStatus } = overlayHealthWithFreshness(
    snapshot.operationalStatus,
    snapshot.qualityStatus,
    freshnessStatus,
  )

  // overview_snapshot 自身の freshness だけでは、build 元となった
  // Accounts/Labels/Attention の read model が遅延していても「最新」に見えてしまう。
  // 主要 read model の worst-of を別途重ね、両者が一致しない場合は注記できるようにする。
  const coreMeta = await getCoreReadModelMeta(prisma)

  return {
    operationalStatus,
    qualityStatus,
    attention,
    latestPipeline,
    sourceDataAt: snapshot.sourceWatermarkAt,
    generationId: readModelState.currentGenerationId,
    policyHash: readModelState.policyHash,
    freshnessStatus,
    coreFreshnessStatus: coreMeta.freshnessStatus,
    corePerModel: coreMeta.perModel,
    coreFreshnessDivergesFromSnapshot: coreMeta.freshnessStatus !== freshnessStatus,
  }
}
