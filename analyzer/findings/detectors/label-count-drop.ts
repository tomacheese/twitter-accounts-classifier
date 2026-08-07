export interface LabelCountSample {
  trueCount: number
  evaluatedCount: number
}

export interface LabelCountDropResult {
  exceeded: boolean
  isMissingOrFailed: boolean
  observedValue: number
  baselineValue: number
  relativeDifference: number
  affectedCount: number
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
