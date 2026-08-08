import type { PrismaClient } from '../generated/prisma'
import type { ReadModelFreshnessStatus } from './api-response'

/** API メタデータのうち read model 側から決まる部分。 */
export interface ReadModelMeta {
  generatedAt: Date
  sourceDataAt: Date | null
  generationId: string | null
  policyHash: string | null
  freshnessStatus: ReadModelFreshnessStatus
}

const FRESHNESS_STATUSES = new Set<string>(['healthy', 'stale', 'failed'])

/**
 * @param status - ReadModelState.status の生値
 * @returns 既知の freshness であればその値、そうでなければ unknown
 */
function toFreshnessStatus(status: string): ReadModelFreshnessStatus {
  return FRESHNESS_STATUSES.has(status) ? (status as ReadModelFreshnessStatus) : 'unknown'
}

/**
 * @param state - 対象の ReadModelState
 * @returns state から組み立てたメタデータ
 */
function toMeta(state: {
  lastSuccessAt: Date | null
  sourceWatermarkAt: Date | null
  currentGenerationId: string | null
  policyHash: string | null
  status: string
}): ReadModelMeta {
  return {
    // 生成時刻はリクエスト時刻ではなくデータが実際に作られた時刻を返す。
    // 前者だと read model が停止していても常に最新に見えてしまう。
    generatedAt: state.lastSuccessAt ?? state.sourceWatermarkAt ?? new Date(0),
    sourceDataAt: state.sourceWatermarkAt,
    generationId: state.currentGenerationId,
    policyHash: state.policyHash,
    freshnessStatus: toFreshnessStatus(state.status),
  }
}

/** ReadModelState が 1 件も無い場合に返すメタデータ。 */
const EMPTY_META: ReadModelMeta = {
  generatedAt: new Date(0),
  sourceDataAt: null,
  generationId: null,
  policyHash: null,
  freshnessStatus: 'unknown',
}

/**
 * @param prisma - Prisma クライアント
 * @param modelKey - 対象の読み取りモデル
 * @returns その読み取りモデルのメタデータ。未記録なら unknown 扱いの既定値
 */
export async function getReadModelMeta(
  prisma: PrismaClient,
  modelKey: string,
): Promise<ReadModelMeta> {
  const state = await prisma.readModelState.findUnique({ where: { modelKey } })
  return state ? toMeta(state) : EMPTY_META
}

/**
 * 特定の読み取りモデルに紐づかない section 向けのメタデータ。
 * ReviewFinding や OperationCycle は generation 管理下に無いため、
 * 最後に成功した読み取りモデルの状態を分析パイプライン全体の鮮度として使う。
 * @param prisma - Prisma クライアント
 * @returns 直近成功した読み取りモデルのメタデータ。未記録なら unknown 扱いの既定値
 */
export async function getPipelineMeta(prisma: PrismaClient): Promise<ReadModelMeta> {
  const states = await prisma.readModelState.findMany()
  if (states.length === 0) return EMPTY_META

  let latest = states[0]
  for (const state of states) {
    if ((state.lastSuccessAt?.getTime() ?? 0) > (latest.lastSuccessAt?.getTime() ?? 0)) {
      latest = state
    }
  }
  // 1 つでも失敗・遅延していれば section 全体の鮮度もそれに引きずられる。
  const worstStatus = states.some((state) => state.status === 'failed')
    ? 'failed'
    : states.some((state) => state.status === 'stale')
      ? 'stale'
      : latest.status

  return { ...toMeta(latest), generationId: null, freshnessStatus: toFreshnessStatus(worstStatus) }
}
