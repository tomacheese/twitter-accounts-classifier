import {
  extractPipelineHealthThresholds,
  parseIsoDurationMs,
  type PipelineHealthThresholds,
} from 'pipeline-health'

export { parseIsoDurationMs }

/** read model freshness を判定するためのしきい値 (ミリ秒)。 */
export interface FreshnessThresholds {
  delayedAfterMs: number
  staleAfterMs: number
}

/**
 * DetectionPolicyVersion.content から read_model_freshness ルールのしきい値を取り出す。
 * @param policyContent - DetectionPolicyVersion.content (JSON)
 * @returns しきい値。ルールが見つからなければ analyzer 側の既定値
 */
export function extractFreshnessThresholds(policyContent: unknown): FreshnessThresholds {
  return extractPipelineHealthThresholds(policyContent).projection
}

export type { PipelineHealthThresholds }

/**
 * lastSuccessAt からの経過時間としきい値だけで freshness を判定する。
 * analyzer 自体が停止して ReadModelState.status の書き込み主体が居なくなっても、
 * Viewer 側の読み取り時点で独立に鮮度を判定できるようにするための純粋関数。
 * @param lastSuccessAt - 直近成功時刻
 * @param thresholds - delayed/stale と判定するまでの経過時間
 * @param now - 判定基準時刻
 * @returns 'delayed' | 'stale' | undefined ('undefined' は経過時間だけでは劣化していないことを表す)
 */
export function deriveElapsedFreshness(
  lastSuccessAt: Date | null,
  thresholds: FreshnessThresholds,
  now: Date,
): 'delayed' | 'stale' | undefined {
  if (!lastSuccessAt) return undefined
  const elapsedMs = now.getTime() - lastSuccessAt.getTime()
  if (elapsedMs >= thresholds.staleAfterMs) return 'stale'
  if (elapsedMs >= thresholds.delayedAfterMs) return 'delayed'
  return undefined
}
