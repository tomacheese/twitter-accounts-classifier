export type FreshnessStatus = 'current' | 'delayed' | 'stale' | 'unknown'

export interface ComputeFreshnessStatusInput {
  lastSuccessAt: Date | undefined
  cadenceMs: number
  delayedAfterMs: number
  staleAfterMs: number
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
