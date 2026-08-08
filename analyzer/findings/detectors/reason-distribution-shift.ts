/**
 * reason_distribution_shift の reason 1 件分の判定結果。
 */
export interface ReasonDistributionShiftResult {
  /** 対象の reason。 */
  reason: string
  /** 閾値を超過したか。 */
  exceeded: boolean
  /** 母数不足などで判定不能か。 */
  isMissingOrFailed: boolean
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
 * reason ごとに現在値・baseline を比較する。
 * fingerprint は reason ごとに独立した lifecycle を持つため、最大変化幅の
 * reason だけに絞らず、比較可能な reason 全件を返す。そうしないと、直前まで
 * 最大変化幅だった reason が別の reason に入れ替わった時点で観測が途切れ、
 * その reason の Finding が resolved に遷移する経路を失う。
 * @param input - reason ごとの現在の分布と baseline
 * @param rule - 判定に使う閾値
 * @returns reason ごとの検出結果
 */
export function evaluateReasonDistributionShifts(
  input: { current: Record<string, number>; baseline: Record<string, number> },
  rule: { relativeThreshold: number; minimumSampleSize: number },
): ReasonDistributionShiftResult[] {
  const reasons = new Set([...Object.keys(input.current), ...Object.keys(input.baseline)])

  const results: ReasonDistributionShiftResult[] = []
  for (const reason of reasons) {
    const currentCount = input.current[reason] ?? 0
    const baselineCount = input.baseline[reason] ?? 0
    if (baselineCount < rule.minimumSampleSize) continue

    const relativeDifference =
      baselineCount === 0 ? 0 : (baselineCount - currentCount) / baselineCount

    results.push({
      reason,
      exceeded: relativeDifference >= rule.relativeThreshold,
      isMissingOrFailed: false,
      observedValue: currentCount,
      baselineValue: baselineCount,
      relativeDifference,
      affectedCount: currentCount,
      totalCount: baselineCount,
    })
  }

  return results
}
