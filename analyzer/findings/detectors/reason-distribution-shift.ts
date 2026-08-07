/**
 * reason_distribution_shift の判定結果。
 */
export interface ReasonDistributionShiftResult {
  /** 閾値を超過したか。 */
  exceeded: boolean
  /** 母数不足などで判定不能か。 */
  isMissingOrFailed: boolean
  /** 最も大きく変化した reason。 */
  reason?: string
  /** 今回の観測値。 */
  observedValue: number
  /** 比較対象の baseline 値。 */
  baselineValue: number
  /** baseline に対する相対変化量。 */
  relativeDifference: number
  /** 影響を受けた件数。 */
  affectedCount: number
  totalCount: number
}

/**
 * reason ごとの現在値・baseline を比較し、最大の相対減少幅を持つ reason を選ぶ。
 * 複数の reason が同時に閾値を超えても変化幅最大のものだけを返す。
 * fingerprint を 1 件に対応させるため。
 * @param input - reason ごとの現在の分布と baseline
 * @param rule - 判定に使う閾値
 * @returns 検出結果
 */
export function evaluateReasonDistributionShift(
  input: { current: Record<string, number>; baseline: Record<string, number> },
  rule: { relativeThreshold: number; minimumSampleSize: number },
): ReasonDistributionShiftResult {
  const reasons = new Set([...Object.keys(input.current), ...Object.keys(input.baseline)])

  let best:
    | { reason: string; currentCount: number; baselineCount: number; relativeDifference: number }
    | undefined

  for (const reason of reasons) {
    const currentCount = input.current[reason] ?? 0
    const baselineCount = input.baseline[reason] ?? 0
    if (baselineCount < rule.minimumSampleSize) continue

    const relativeDifference =
      baselineCount === 0 ? 0 : (baselineCount - currentCount) / baselineCount
    if (!best || relativeDifference > best.relativeDifference) {
      best = { reason, currentCount, baselineCount, relativeDifference }
    }
  }

  if (!best) {
    return {
      exceeded: false,
      isMissingOrFailed: true,
      observedValue: 0,
      baselineValue: 0,
      relativeDifference: 0,
      affectedCount: 0,
      totalCount: 0,
    }
  }

  return {
    exceeded: best.relativeDifference >= rule.relativeThreshold,
    isMissingOrFailed: false,
    reason: best.reason,
    observedValue: best.currentCount,
    baselineValue: best.baselineCount,
    relativeDifference: best.relativeDifference,
    affectedCount: best.currentCount,
    totalCount: best.baselineCount,
  }
}
