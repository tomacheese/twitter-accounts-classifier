import type { PrismaClient } from '../generated/prisma'
import type { ReadModelFreshnessStatus } from './api-response'
import {
  deriveElapsedFreshness,
  extractFreshnessThresholds,
  type FreshnessThresholds,
} from './policy-freshness'

/** API メタデータのうち read model 側から決まる部分。 */
export interface ReadModelMeta {
  generatedAt: Date
  sourceDataAt: Date | null
  generationId: string | null
  policyHash: string | null
  freshnessStatus: ReadModelFreshnessStatus
}

const FRESHNESS_STATUSES = new Set<string>(['healthy', 'delayed', 'stale', 'failed'])

/**
 * @param status - ReadModelState.status の生値
 * @returns 既知の freshness であればその値、そうでなければ unknown
 */
export function toFreshnessStatus(status: string): ReadModelFreshnessStatus {
  return FRESHNESS_STATUSES.has(status) ? (status as ReadModelFreshnessStatus) : 'unknown'
}

// 劣化度合いの順序。DB に保存された status と、経過時間から独立に導出した
// freshness のうち、より劣化している側を採用するために使う。
const DEGRADATION_ORDER: Record<ReadModelFreshnessStatus, number> = {
  unknown: 0,
  healthy: 0,
  delayed: 1,
  stale: 2,
  failed: 3,
}

/**
 * DB に保存された status と、lastSuccessAt からの経過時間だけで独立に判定した
 * freshness のうち、より劣化している側を返す。
 * analyzer プロセス自体が停止すると status を更新する主体が居なくなり、
 * 停止直前の値が healthy のまま固定されてしまうため、読み取り時点で経過時間からも
 * 再評価する。failed は publish が記録した確定的な失敗であり、経過時間で
 * 上書きしない (analyzer/operational-issues/freshness.ts と同じ扱い)。
 * @param storedStatus - ReadModelState.status から変換した freshness
 * @param lastSuccessAt - 直近成功時刻
 * @param thresholds - delayed/stale と判定するまでの経過時間
 * @param now - 判定基準時刻
 * @returns 劣化がより進んでいる側の freshness
 */
export function reconcileFreshness(
  storedStatus: ReadModelFreshnessStatus,
  lastSuccessAt: Date | null,
  thresholds: FreshnessThresholds,
  now: Date,
): ReadModelFreshnessStatus {
  if (storedStatus === 'failed') return storedStatus
  const elapsedStatus = deriveElapsedFreshness(lastSuccessAt, thresholds, now)
  if (!elapsedStatus) return storedStatus
  return DEGRADATION_ORDER[elapsedStatus] > DEGRADATION_ORDER[storedStatus]
    ? elapsedStatus
    : storedStatus
}

/**
 * @param state - 対象の ReadModelState
 * @param thresholds - delayed/stale と判定するまでの経過時間
 * @param now - 判定基準時刻
 * @returns state から組み立てたメタデータ
 */
function toMeta(
  state: {
    lastSuccessAt: Date | null
    sourceWatermarkAt: Date | null
    currentGenerationId: string | null
    policyHash: string | null
    status: string
  },
  thresholds: FreshnessThresholds,
  now: Date,
): ReadModelMeta {
  return {
    // 生成時刻はリクエスト時刻ではなくデータが実際に作られた時刻を返す。
    // 前者だと read model が停止していても常に最新に見えてしまう。
    generatedAt: state.lastSuccessAt ?? state.sourceWatermarkAt ?? new Date(0),
    sourceDataAt: state.sourceWatermarkAt,
    generationId: state.currentGenerationId,
    policyHash: state.policyHash,
    freshnessStatus: reconcileFreshness(
      toFreshnessStatus(state.status),
      state.lastSuccessAt,
      thresholds,
      now,
    ),
  }
}

/**
 * @param prisma - Prisma クライアント
 * @returns 適用中 policy から取り出した freshness しきい値。未ロードなら既定値
 */
async function getFreshnessThresholds(prisma: PrismaClient): Promise<FreshnessThresholds> {
  const policyVersion = await prisma.detectionPolicyVersion.findFirst({
    orderBy: { loadedAt: 'desc' },
  })
  return extractFreshnessThresholds(policyVersion?.content)
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
  if (!state) return EMPTY_META
  const thresholds = await getFreshnessThresholds(prisma)
  return toMeta(state, thresholds, new Date())
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

  const thresholds = await getFreshnessThresholds(prisma)
  const now = new Date()

  let latest = states[0]
  let worstStatus: ReadModelFreshnessStatus = 'unknown'
  for (const state of states) {
    if ((state.lastSuccessAt?.getTime() ?? 0) > (latest.lastSuccessAt?.getTime() ?? 0)) {
      latest = state
    }
    // 1 つでも失敗・遅延していれば section 全体の鮮度もそれに引きずられる。
    const reconciled = reconcileFreshness(
      toFreshnessStatus(state.status),
      state.lastSuccessAt,
      thresholds,
      now,
    )
    if (DEGRADATION_ORDER[reconciled] > DEGRADATION_ORDER[worstStatus]) {
      worstStatus = reconciled
    }
  }

  return {
    ...toMeta(latest, thresholds, now),
    generationId: null,
    freshnessStatus: worstStatus,
  }
}
