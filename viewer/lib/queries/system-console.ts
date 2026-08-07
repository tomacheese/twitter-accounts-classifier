import type { PrismaClient } from '../../generated/prisma'

export interface SystemIdentity {
  applicationVersion: string
  environment: string
}

export interface SystemComponentHealth {
  operationalStatus: string
  qualityStatus: string
  sourceWatermarkAt: Date
  generatedAt: Date
}

export interface SystemActivePolicy {
  policyVersion: string
  contentHash: string
  schemaVersion: number
  loadedAt: Date
}

export interface SystemReadModelStatus {
  modelKey: string
  status: string
  schemaVersion: number
  lastSuccessAt: Date | null
  staleAt: Date | null
  errorSummary: string | null
}

export interface SystemDiagnosticsEnvVar {
  key: string
  value: string
}

export interface SystemConsoleData {
  identity: SystemIdentity
  componentHealth: SystemComponentHealth | null
  activePolicy: SystemActivePolicy | null
  readModels: SystemReadModelStatus[]
  diagnosticsEnvVars: SystemDiagnosticsEnvVar[]
}

// 接続文字列・token など秘密情報が含まれうる環境変数は、denylist ではなく
// 表示してよい値だけを列挙する allowlist 方式で除外する。
const DIAGNOSTICS_ENV_VAR_ALLOWLIST = [
  'NODE_ENV',
  'VIEWER_NEW_UI_SECTIONS',
  'ANALYZER_WORKER_CONCURRENCY',
  'ANALYZER_POLL_INTERVAL_SECONDS',
]

/**
 * spec の 8 セクション (System identity → Component health → Active policy →
 * Detector/schema versions → Schedule/freshness → Read model status →
 * Data retention → Diagnostics) のうち、DB から取得可能な部分を組み立てる。
 * Component health は Overview が保存した OverviewSnapshot の operationalStatus/
 * qualityStatus をそのまま読み、System 側では再計算しない。
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
      errorSummary: state.errorSummary,
    })),
    diagnosticsEnvVars: DIAGNOSTICS_ENV_VAR_ALLOWLIST.filter(
      (key) => process.env[key] !== undefined,
    ).map((key) => ({ key, value: process.env[key] ?? '' })),
  }
}
