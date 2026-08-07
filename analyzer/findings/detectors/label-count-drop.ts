/**
 * 1 時点における Label の集計値。
 */
export interface LabelCountSample {
  /** Label が true と判定された件数。 */
  trueCount: number
  /** 判定対象となった件数。 */
  evaluatedCount: number
}

/**
 * label_count_drop の判定結果。
 */
export interface LabelCountDropResult {
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
  /** 影響範囲の母数。 */
  totalCount: number
}

/**
 * @param input - 現在値と baseline
 * @param rule - 判定に使う閾値
 * @returns 検出結果
 */
export function evaluateLabelCountDrop(
  input: { current: LabelCountSample; baseline: LabelCountSample },
  rule: { relativeThreshold: number; minimumSampleSize: number },
): LabelCountDropResult {
  const isMissingOrFailed =
    input.current.evaluatedCount < rule.minimumSampleSize ||
    input.baseline.evaluatedCount < rule.minimumSampleSize

  const relativeDifference =
    input.baseline.trueCount === 0
      ? 0
      : (input.baseline.trueCount - input.current.trueCount) / input.baseline.trueCount

  return {
    exceeded: !isMissingOrFailed && relativeDifference >= rule.relativeThreshold,
    isMissingOrFailed,
    observedValue: input.current.trueCount,
    baselineValue: input.baseline.trueCount,
    relativeDifference,
    affectedCount: input.current.trueCount,
    totalCount: input.current.evaluatedCount,
  }
}
