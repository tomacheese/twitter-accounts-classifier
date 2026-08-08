/**
 * ISO 8601 duration (P30D, PT3H, PT12H 等) のうち read model freshness で使う範囲だけを解釈する。
 * analyzer/findings/lifecycle.ts の parseIsoDurationMs と同じ実装だが、
 * viewer と analyzer はパッケージが分かれており共有 lib を持たないため、ここで複製する。
 * @param duration - ISO 8601 duration 文字列
 * @returns ミリ秒
 */
export function parseIsoDurationMs(duration: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(duration)
  if (!match) throw new Error(`unsupported duration format: ${duration}`)
  const days = Number(match[1] || 0)
  const hours = Number(match[2] || 0)
  const minutes = Number(match[3] || 0)
  return ((days * 24 + hours) * 60 + minutes) * 60 * 1000
}

// analyzer/worker-processors.ts の DEFAULT_READ_MODEL_DELAYED_AFTER / DEFAULT_READ_MODEL_STALE_AFTER と揃える。
// policy が未ロード (DetectionPolicyVersion が 1 件も無い) 場合のフォールバック値として使う。
const DEFAULT_DELAYED_AFTER = 'PT3H'
const DEFAULT_STALE_AFTER = 'PT12H'

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
  const rules =
    policyContent &&
    typeof policyContent === 'object' &&
    'rules' in policyContent &&
    Array.isArray((policyContent as { rules: unknown }).rules)
      ? (policyContent as { rules: unknown[] }).rules
      : []

  const rule = rules.find(
    (
      entry,
    ): entry is { type: string; enabled: boolean; delayedAfter?: string; staleAfter?: string } =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { type?: unknown }).type === 'read_model_freshness' &&
      (entry as { enabled?: unknown }).enabled === true,
  )

  return {
    delayedAfterMs: parseIsoDurationMs(rule?.delayedAfter ?? DEFAULT_DELAYED_AFTER),
    staleAfterMs: parseIsoDurationMs(rule?.staleAfter ?? DEFAULT_STALE_AFTER),
  }
}

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
