import type { DetectionPolicyRule } from '../policy/schema'

/**
 * 'new_episode' は新しい episodeNumber の ReviewFinding を作るトリガーを表す一時的な結果で、
 * 永続状態としては 'active' に相当する。
 */
export type FindingLifecycleStatus = 'none' | 'active' | 'resolved' | 'recurring' | 'new_episode'

/**
 * lifecycle 状態機械が保持する状態。
 */
export interface FindingLifecycleState {
  /** 現在の lifecycle 状態。 */
  status: FindingLifecycleStatus
  /** 連続で閾値を超過した回数。 */
  consecutiveExceed: number
  /** 連続で閾値を下回った回数。 */
  consecutiveNormal: number
  /** 直近で resolved になった時刻。 */
  resolvedAt?: Date
}

/**
 * 1 回の検出器評価の結果。
 */
export interface DetectorObservation {
  /** 閾値を超過したか。 */
  exceeded: boolean
  /** 母数不足や評価失敗で判定不能か。 */
  isMissingOrFailed: boolean
}

/**
 * ISO 8601 duration (P30D, P7D, PT1H 等) のうち本ドメインで使う範囲だけを解釈する。
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
 * @param resolvedAt - 直近で resolved になった時刻
 * @param cooldown - 再 activation を抑止する期間 (ISO 8601 duration)
 * @param now - 現在時刻
 * @returns 抑止期間内かどうか
 */
function isWithinCooldown(
  resolvedAt: Date | undefined,
  cooldown: string | undefined,
  now: Date,
): boolean {
  if (!resolvedAt || !cooldown) return false
  return now.getTime() - resolvedAt.getTime() < parseIsoDurationMs(cooldown)
}

/**
 * 状態を DB へ直接書かず、次に取るべき状態だけを返す純粋関数にしている。
 * DB access を含めるとテストのたびに接続が必要になるため。
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

  // 'recurring' はこの再活性化ゲートの対象に含めない。すでに一度ゲートを
  // 通過して継続監視に入っている状態であり、ここに含めると通常監視のはずの
  // 観測のたびに activationCount を数え直してしまい、resolutionCount へ
  // 到達する経路が失われる。
  if (state.status === 'none' || state.status === 'resolved') {
    if (!observation.exceeded) {
      return { ...state, consecutiveExceed: 0 }
    }

    const consecutiveExceed = state.consecutiveExceed + 1
    const activationCount = rule.criticalImmediate ? 1 : rule.activationCount

    if (consecutiveExceed < activationCount) {
      return { ...state, consecutiveExceed, consecutiveNormal: 0 }
    }

    // 解消直後の閾値付近の揺れで active と resolved を往復させないよう、
    // cooldown の間は連続超過回数だけ数えて再 activation を保留する。
    if (isWithinCooldown(state.resolvedAt, rule.cooldown, now)) {
      return { ...state, consecutiveExceed, consecutiveNormal: 0 }
    }

    if (state.status === 'resolved') {
      const withinWindow = isWithinRecurrenceWindow(state.resolvedAt, rule.recurrenceWindow, now)
      return {
        status: withinWindow ? 'recurring' : 'new_episode',
        consecutiveExceed,
        consecutiveNormal: 0,
      }
    }

    return { status: 'active', consecutiveExceed, consecutiveNormal: 0 }
  }

  if (observation.exceeded) {
    return { ...state, consecutiveNormal: 0 }
  }

  const consecutiveNormal = state.consecutiveNormal + 1
  if (consecutiveNormal < rule.resolutionCount) {
    return { ...state, consecutiveNormal }
  }

  return { status: 'resolved', consecutiveExceed: 0, consecutiveNormal, resolvedAt: now }
}
