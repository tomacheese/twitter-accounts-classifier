import type { PrismaClient } from '../../generated/prisma'
import {
  overlayHealthWithFreshness,
  reconcileFreshness,
  toFreshnessStatus,
} from '../read-model-meta'
import { extractFreshnessThresholds } from '../policy-freshness'

/** 稼働中システムの識別情報。 */
export interface SystemIdentity {
  applicationVersion: string
  environment: string
}

/** 各コンポーネントの健全性。 */
export interface SystemComponentHealth {
  operationalStatus: string
  qualityStatus: string
  sourceWatermarkAt: Date
  generatedAt: Date
}

/** 適用中の検知ポリシー。 */
export interface SystemActivePolicy {
  policyVersion: string
  contentHash: string
  schemaVersion: number
  loadedAt: Date
}

/** read model 1 種類分の状態。 */
export interface SystemReadModelStatus {
  modelKey: string
  status: string
  schemaVersion: number
  lastSuccessAt: Date | null
  staleAt: Date | null
  errorSummary: string | null
}

/** 診断用に表示を許可した環境変数。 */
export interface SystemDiagnosticsEnvVar {
  key: string
  value: string
}

/** System 画面の表示内容。 */
export interface SystemConsoleData {
  identity: SystemIdentity
  componentHealth: SystemComponentHealth | null
  activePolicy: SystemActivePolicy | null
  readModels: SystemReadModelStatus[]
  diagnosticsEnvVars: SystemDiagnosticsEnvVar[]
}

// 秘密情報が含まれうる環境変数を denylist で除くと、追加時に漏れる。
// 表示してよい値だけを列挙する allowlist 方式にする。
const DIAGNOSTICS_ENV_VAR_ALLOWLIST = [
  'NODE_ENV',
  'VIEWER_NEW_UI_SECTIONS',
  'ANALYZER_WORKER_CONCURRENCY',
  'ANALYZER_POLL_INTERVAL_SECONDS',
]

const ERROR_SUMMARY_MAX_LENGTH = 200

/**
 * ReadModelState.errorSummary は例外の文字列化そのものである。
 * Prisma のエラーには、クエリ引数として実在アカウントの情報が混じりうる。
 * 書き込み側の内容に依存せず、画面には分類に足る先頭 1 行だけを長さ上限付きで出す。
 * @param errorSummary - 保存されている生のエラー文字列
 * @returns 表示用に切り詰めたエラー文字列。元が null なら null
 */
function redactErrorSummary(errorSummary: string | null): string | null {
  if (errorSummary === null) return null
  const firstLine = errorSummary.split('\n')[0].trim()
  return firstLine.length > ERROR_SUMMARY_MAX_LENGTH
    ? `${firstLine.slice(0, ERROR_SUMMARY_MAX_LENGTH)}…`
    : firstLine
}

/**
 * System コンソールの表示内容を、DB から取得可能な範囲で組み立てる。
 * Component health は Overview が保存した OverviewSnapshot の値を基本とするが、
 * overview_snapshot 自体の freshness が stale/failed の場合は上書きする。
 * generatedAt DESC ではなく ReadModelState.currentGenerationId を経由して取得する。
 * generatedAt DESC だと、Pointer 切り替えに失敗した (superseded/failed) generation の
 * 方が新しい generatedAt を持つ場合に、公開されていない snapshot を表示してしまう。
 * @param prisma - Prisma クライアント
 * @returns System コンソール表示用データ
 */
export async function getSystemConsoleData(prisma: PrismaClient): Promise<SystemConsoleData> {
  const [overviewReadModelState, latestPolicy, readModelStates] = await Promise.all([
    prisma.readModelState.findUnique({ where: { modelKey: 'overview_snapshot' } }),
    prisma.detectionPolicyVersion.findFirst({ orderBy: [{ loadedAt: 'desc' }] }),
    prisma.readModelState.findMany(),
  ])
  const latestSnapshot = overviewReadModelState?.currentGenerationId
    ? await prisma.overviewSnapshot.findUnique({
        where: { generationId: overviewReadModelState.currentGenerationId },
      })
    : null

  const thresholds = extractFreshnessThresholds(latestPolicy?.content)
  // overview_snapshot 自体が stale/failed になった場合、componentHealth が読む
  // OverviewSnapshot.operationalStatus/qualityStatus は build 時点で固定された
  // 古い値のままになる。readModels[] と同じ reconcileFreshness で上書きする。
  const overviewFreshness = overviewReadModelState
    ? reconcileFreshness(
        toFreshnessStatus(overviewReadModelState.status),
        overviewReadModelState.lastSuccessAt,
        thresholds,
        new Date(),
      )
    : 'unknown'

  return {
    identity: {
      applicationVersion: process.env.npm_package_version ?? 'unknown',
      environment: process.env.NODE_ENV,
    },
    componentHealth: latestSnapshot
      ? {
          ...overlayHealthWithFreshness(
            latestSnapshot.operationalStatus,
            latestSnapshot.qualityStatus,
            overviewFreshness,
          ),
          sourceWatermarkAt: latestSnapshot.sourceWatermarkAt,
          generatedAt: latestSnapshot.generatedAt,
        }
      : null,
    activePolicy: latestPolicy
      ? {
          policyVersion: latestPolicy.policyVersion,
          contentHash: latestPolicy.contentHash,
          schemaVersion: latestPolicy.schemaVersion,
          loadedAt: latestPolicy.loadedAt,
        }
      : null,
    readModels: readModelStates.map((state) => {
      return {
        modelKey: state.modelKey,
        // analyzer プロセス自体が停止すると status を更新する主体が居なくなるため、
        // 経過時間からも独立に再評価し、より劣化している側を返す。
        status: reconcileFreshness(
          toFreshnessStatus(state.status),
          state.lastSuccessAt,
          thresholds,
          new Date(),
        ),
        schemaVersion: state.schemaVersion,
        lastSuccessAt: state.lastSuccessAt,
        staleAt: state.staleAt,
        errorSummary: redactErrorSummary(state.errorSummary),
      }
    }),
    diagnosticsEnvVars: DIAGNOSTICS_ENV_VAR_ALLOWLIST.filter(
      (key) => process.env[key] !== undefined,
    ).map((key) => ({ key, value: process.env[key] ?? '' })),
  }
}
