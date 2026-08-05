export type HealthStatus =
  'running' | 'healthy' | 'degraded' | 'failed' | 'stale' | 'not_run' | 'unknown'

/** health status 導出に必要な、直近の実行1件分の生データ。 */
export interface RawRunState {
  status: string
  staleAfterAt: Date | null
}

const HEALTHY_STATUSES = new Set(['success', 'completed'])
const FAILED_STATUSES = new Set(['failed', 'timeout'])

/**
 * サービスごとに raw status の語彙が異なるため、個別に分岐を用意するのではなく
 * ここで共通の health status へ畳み込むことで、判定ロジックを一箇所に集約している。
 * @param run - 対象サービスの直近の実行。実行記録が一件もなければ `null`
 * @param now - 判定基準時刻
 * @returns 導出された health status
 */
export function deriveHealthStatus(run: RawRunState | null, now: Date): HealthStatus {
  if (!run) return 'not_run'

  if (run.status === 'running') {
    if (run.staleAfterAt && run.staleAfterAt.getTime() < now.getTime()) return 'stale'
    return 'running'
  }
  if (HEALTHY_STATUSES.has(run.status)) return 'healthy'
  if (run.status === 'partial') return 'degraded'
  if (FAILED_STATUSES.has(run.status)) return 'failed'
  return 'unknown'
}
