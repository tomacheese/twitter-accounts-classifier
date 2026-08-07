import type { PrismaClient } from '../../generated/prisma'

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
 * Component health は Overview が保存した OverviewSnapshot の値をそのまま読み、
 * System 側では再計算しない。
 * @param prisma - Prisma クライアント
 * @returns System コンソール表示用データ
 */
export async function getSystemConsoleData(prisma: PrismaClient): Promise<SystemConsoleData> {
  const [latestSnapshot, latestPolicy, readModelStates] = await Promise.all([
    prisma.overviewSnapshot.findFirst({ orderBy: [{ generatedAt: 'desc' }] }),
    prisma.detectionPolicyVersion.findFirst({ orderBy: [{ loadedAt: 'desc' }] }),
    prisma.readModelState.findMany(),
  ])

  return {
    identity: {
      applicationVersion: process.env.npm_package_version ?? 'unknown',
      environment: process.env.NODE_ENV,
    },
    componentHealth: latestSnapshot
      ? {
          operationalStatus: latestSnapshot.operationalStatus,
          qualityStatus: latestSnapshot.qualityStatus,
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
    readModels: readModelStates.map((state) => ({
      modelKey: state.modelKey,
      status: state.status,
      schemaVersion: state.schemaVersion,
      lastSuccessAt: state.lastSuccessAt,
      staleAt: state.staleAt,
      errorSummary: redactErrorSummary(state.errorSummary),
    })),
    diagnosticsEnvVars: DIAGNOSTICS_ENV_VAR_ALLOWLIST.filter(
      (key) => process.env[key] !== undefined,
    ).map((key) => ({ key, value: process.env[key] ?? '' })),
  }
}
