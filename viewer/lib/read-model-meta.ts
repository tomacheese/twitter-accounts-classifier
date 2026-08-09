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
export async function getFreshnessThresholds(prisma: PrismaClient): Promise<FreshnessThresholds> {
  const policyVersion = await prisma.detectionPolicyVersion.findFirst({
    orderBy: { loadedAt: 'desc' },
  })
  return extractFreshnessThresholds(policyVersion?.content)
}

/**
 * OverviewSnapshot が build された時点の operationalStatus/qualityStatus は、
 * analyzer が停止して以降 build されなくなると更新されない。
 * 「読み取りモデル更新失敗または stale は Operational Health を critical、
 * Classification Quality を unknown とする」という設計に合わせ、
 * 経過時間から再評価した freshness が stale/failed の場合は上書きする。
 * @param operationalStatus - build 時点の Operational Health
 * @param qualityStatus - build 時点の Classification Quality
 * @param freshnessStatus - reconcileFreshness で再評価した freshness
 * @returns 表示に使う Operational Health / Classification Quality
 */
export function overlayHealthWithFreshness(
  operationalStatus: string,
  qualityStatus: string,
  freshnessStatus: ReadModelFreshnessStatus,
): { operationalStatus: string; qualityStatus: string } {
  if (freshnessStatus === 'stale' || freshnessStatus === 'failed') {
    return { operationalStatus: 'critical', qualityStatus: 'unknown' }
  }
  return { operationalStatus, qualityStatus }
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

/** worst-of 計算の対象にできる ReadModelState の最小形。 */
interface WorstOfState {
  modelKey: string
  lastSuccessAt: Date | null
  sourceWatermarkAt: Date | null
  currentGenerationId: string | null
  policyHash: string | null
  status: string
}

/** worst-of 計算の結果。 */
interface WorstOfResult<T> {
  latest: T
  worstStatus: ReadModelFreshnessStatus
  perModel: CoreReadModelStatus[]
}

/**
 * 複数の ReadModelState から、最も劣化している freshness と lastSuccessAt が最も新しい state を求める。
 * getPipelineMeta と getCoreReadModelMeta の両方から呼ぶ共通ロジック。
 * @param states - worst-of の対象とする ReadModelState の一覧
 * @param thresholds - delayed/stale と判定するまでの経過時間
 * @param now - 判定基準時刻
 * @returns 最も劣化している状態、lastSuccessAt が最新の state、モデルごとの内訳
 */
function computeWorstOf<T extends WorstOfState>(
  states: T[],
  thresholds: FreshnessThresholds,
  now: Date,
): WorstOfResult<T> {
  let latest = states[0]
  // unknown と healthy は DEGRADATION_ORDER 上どちらも 0 のため、'unknown' 初期値に
  // 対して > 比較するだけでは全 state が healthy でも初期値から更新されない。
  // 実在する範囲外の順位から始めて必ず 1 回目で上書きされるようにする。
  let worstStatus: ReadModelFreshnessStatus = 'healthy'
  let worstOrder = -1
  const perModel: CoreReadModelStatus[] = []
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
    perModel.push({ modelKey: state.modelKey, freshnessStatus: reconciled })
    const order = DEGRADATION_ORDER[reconciled]
    if (order > worstOrder) {
      worstOrder = order
      worstStatus = reconciled
    }
  }
  return { latest, worstStatus, perModel }
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
  const { latest, worstStatus } = computeWorstOf(states, thresholds, now)

  return {
    ...toMeta(latest, thresholds, now),
    generationId: null,
    freshnessStatus: worstStatus,
  }
}

// Overview の総合 freshness と揃える主要 read model。
// block_relation は Block 機能を使わない環境では Pointer が作られないため、固定の Set には含めず呼び出し側で判定する。
const CORE_MODEL_KEYS = ['account_summary_latest', 'label_summary', 'attention_items'] as const

/** 主要 read model 1 件分の freshness。 */
export interface CoreReadModelStatus {
  modelKey: string
  freshnessStatus: ReadModelFreshnessStatus
}

/** Overview の総合 freshness と、その内訳。 */
export interface CoreReadModelMeta extends ReadModelMeta {
  perModel: CoreReadModelStatus[]
}

/** ReadModelState が 1 件も無い場合に返す CoreReadModelMeta。 */
const EMPTY_CORE_META: CoreReadModelMeta = { ...EMPTY_META, perModel: [] }

/**
 * Overview の総合 freshness を、主要 read model の worst-of として計算する。
 * overview_snapshot 自身の freshness ではなく、Accounts/Labels/Attention の元データの freshness を対象にすることで、「表示は最新だが元データは遅延している」状態を見逃さないようにする。
 * @param prisma - Prisma クライアント
 * @returns 主要 read model の worst-of と、モデルごとの内訳
 */
export async function getCoreReadModelMeta(prisma: PrismaClient): Promise<CoreReadModelMeta> {
  const [states, blockRelationPointer] = await Promise.all([
    prisma.readModelState.findMany({ where: { modelKey: { in: [...CORE_MODEL_KEYS] } } }),
    prisma.readModelPointer.findUnique({ where: { modelKey: 'block_relation' } }),
  ])

  if (blockRelationPointer) {
    const blockRelationState = await prisma.readModelState.findUnique({
      where: { modelKey: 'block_relation' },
    })
    if (blockRelationState) states.push(blockRelationState)
  }

  if (states.length === 0) return EMPTY_CORE_META

  const thresholds = await getFreshnessThresholds(prisma)
  const now = new Date()
  const { latest, worstStatus, perModel } = computeWorstOf(states, thresholds, now)

  return {
    ...toMeta(latest, thresholds, now),
    generationId: null,
    freshnessStatus: worstStatus,
    perModel,
  }
}

/** Accounts/Labels 区画の状態。 */
export type ReadModelReadinessStatus = 'ready' | 'bootstrapping' | 'failed' | 'unavailable'

/** Accounts/Labels それぞれの readiness。 */
export interface ReadModelReadiness {
  accounts: ReadModelReadinessStatus
  labels: ReadModelReadinessStatus
}

/**
 * `ReadModelBootstrap`(account_summary の bootstrap 進捗) と
 * `ReadModelState`(label_summary の freshness・generation) を組み合わせて、
 * Accounts/Labels それぞれの ready/bootstrapping/failed/unavailable を判定する。
 * 「1 件以上存在すれば ready」という弱い判定にせず、bootstrap 完了・
 * (Labels は) 全 Label 分の generation 完成を明示的に要求する。
 * @param prisma - Prisma クライアント
 * @returns Accounts/Labels の readiness
 */
export async function getReadModelReadiness(prisma: PrismaClient): Promise<ReadModelReadiness> {
  const [
    bootstrap,
    accountSummaryLatestState,
    labelSummaryState,
    labelSummaryPointer,
    labelDefinitionCount,
  ] = await Promise.all([
    prisma.readModelBootstrap.findUnique({ where: { modelKey: 'account_summary' } }),
    prisma.readModelState.findUnique({ where: { modelKey: 'account_summary_latest' } }),
    prisma.readModelState.findUnique({ where: { modelKey: 'label_summary' } }),
    prisma.readModelPointer.findUnique({ where: { modelKey: 'label_summary' } }),
    prisma.labelDefinition.count(),
  ])

  const bootstrapStatus = bootstrap?.status ?? 'pending'

  let accounts: ReadModelReadinessStatus
  if (bootstrapStatus === 'failed' || accountSummaryLatestState?.status === 'failed') {
    accounts = 'failed'
  } else if (bootstrapStatus === 'pending' || bootstrapStatus === 'running') {
    accounts = 'bootstrapping'
  } else if (bootstrapStatus === 'completed') {
    accounts = 'ready'
  } else {
    accounts = 'unavailable'
  }

  let labelGenerationComplete = false
  if (labelSummaryPointer) {
    const generation = await prisma.readModelGeneration.findUnique({
      where: { id: labelSummaryPointer.currentGenerationId },
    })
    labelGenerationComplete =
      generation?.status === 'current' &&
      generation.rowCount === labelDefinitionCount &&
      labelDefinitionCount > 0
  }

  let labels: ReadModelReadinessStatus
  if (accounts === 'failed' || labelSummaryState?.status === 'failed') {
    labels = 'failed'
  } else if (accounts === 'bootstrapping' || !labelGenerationComplete) {
    labels = 'bootstrapping'
  } else if (accounts === 'ready') {
    labels = 'ready'
  } else {
    labels = 'unavailable'
  }

  return { accounts, labels }
}
