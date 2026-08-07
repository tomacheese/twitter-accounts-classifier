/** データ鮮度の判定結果。 */
export type FreshnessStatus = 'current' | 'delayed' | 'stale' | 'unknown'

/**
 * computeFreshnessStatus の入力。
 */
export interface ComputeFreshnessStatusInput {
  /** 直近で成功した時刻。 */
  lastSuccessAt: Date | undefined
  /** 想定している実行間隔 (ミリ秒)。 */
  cadenceMs: number
  /** delayed とみなすまでの経過時間 (ミリ秒)。 */
  delayedAfterMs: number
  /** stale とみなすまでの経過時間 (ミリ秒)。 */
  staleAfterMs: number
  /** 判定の基準時刻。 */
  now: Date
}

/**
 * @param input - 直近成功時刻としきい値
 * @returns 鮮度状態
 */
export function computeFreshnessStatus(input: ComputeFreshnessStatusInput): FreshnessStatus {
  if (!input.lastSuccessAt) return 'unknown'
  const elapsedMs = input.now.getTime() - input.lastSuccessAt.getTime()
  if (elapsedMs >= input.staleAfterMs) return 'stale'
  if (elapsedMs >= input.delayedAfterMs) return 'delayed'
  return 'current'
}
