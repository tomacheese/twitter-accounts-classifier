import type { DetectionPolicyRule } from '../policy/schema'

/**
 * 'new_episode' は呼び出し側 (Task 14) が「新しい episodeNumber の ReviewFinding を
 * 作る」トリガーとして扱う一時的な遷移結果であり、次回以降の永続状態としては
 * 'active' に相当する。
 */
export type FindingLifecycleStatus = 'none' | 'active' | 'resolved' | 'recurring' | 'new_episode'

export interface FindingLifecycleState {
  status: FindingLifecycleStatus
  consecutiveExceed: number
  consecutiveNormal: number
  resolvedAt?: Date
}

export interface DetectorObservation {
  exceeded: boolean
  isMissingOrFailed: boolean
}

/**
 * ISO 8601 duration (P30D, P7D, PT1H 等) のうち本ドメインで使う範囲だけを解釈する。
 * @param duration - ISO 8601 duration 文字列
 * @returns ミリ秒
 */
function parseIsoDurationMs(duration: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?)?$/.exec(duration)
  if (!match) throw new Error(`unsupported duration format: ${duration}`)
  const days = Number(match[1] || 0)
  const hours = Number(match[2] || 0)
  return (days * 24 + hours) * 60 * 60 * 1000
}

/**
 * @param resolvedAt - 直近で resolved になった時刻
 * @param recurrenceWindow - 再発とみなす期間 (ISO 8601 duration)
 * @param now - 現在時刻
 * @returns 再発ウィンドウ内かどうか
 */
function isWithinRecurrenceWindow(
  resolvedAt: Date | undefined,
  recurrenceWindow: string | undefined,
  now: Date,
): boolean {
  if (!resolvedAt || !recurrenceWindow) return false
  const windowMs = parseIsoDurationMs(recurrenceWindow)
  return now.getTime() - resolvedAt.getTime() <= windowMs
}

/**
 * status: 'new_episode' は呼び出し側 (Task 14) が「新しい episodeNumber の
 * ReviewFinding を作る」トリガーとして扱う。lifecycle 自体は state を
 * 直接 DB へ書かず、次に取るべき状態だけを返す純粋関数にする
 * (DB access を含めるとテストのために毎回接続が必要になるため)。
 * @param state - 現在の lifecycle 状態
 * @param observation - 今回の評価結果
 * @param rule - 適用する検出ルール
 * @param now - 評価時刻
 * @returns 遷移後の lifecycle 状態
 */
export function applyLifecycleTransition(
  state: FindingLifecycleState,
  observation: DetectorObservation,
  rule: DetectionPolicyRule,
  now: Date,
): FindingLifecycleState {
  if (observation.isMissingOrFailed) {
    // 母数不足・評価失敗は連続回数を進めない。状態も変えない。
    return { ...state }
  }

  if (state.status === 'none' || state.status === 'resolved' || state.status === 'recurring') {
    if (!observation.exceeded) {
      return { ...state, consecutiveExceed: 0 }
    }

    const consecutiveExceed = state.consecutiveExceed + 1
    const activationCount = rule.criticalImmediate ? 1 : rule.activationCount

    if (consecutiveExceed < activationCount) {
      return { ...state, consecutiveExceed, consecutiveNormal: 0 }
    }

    if (state.status === 'resolved' || state.status === 'recurring') {
      const withinWindow = isWithinRecurrenceWindow(state.resolvedAt, rule.recurrenceWindow, now)
      return {
        status: withinWindow ? 'recurring' : 'new_episode',
        consecutiveExceed,
        consecutiveNormal: 0,
      }
    }

    return { status: 'active', consecutiveExceed, consecutiveNormal: 0 }
  }

  // active: 解消判定
  if (observation.exceeded) {
    return { ...state, consecutiveNormal: 0 }
  }

  const consecutiveNormal = state.consecutiveNormal + 1
  if (consecutiveNormal < rule.resolutionCount) {
    return { ...state, consecutiveNormal }
  }

  return { status: 'resolved', consecutiveExceed: 0, consecutiveNormal, resolvedAt: now }
}
