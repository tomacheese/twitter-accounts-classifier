import type { FollowGraphLabelSignal } from './follow-graph-label-index'

// サンプルの分母がこれ未満では少数の偶然の一致で発火してしまうため、この値を下限とする。
const MIN_FOLLOWEE_SAMPLE = 15
// フォロー先の3割以上が該当ラベルを持つ場合のみ、その関心を強い関連性とみなす。
const MIN_FOLLOWEE_LABELED_RATIO = 0.3

export interface FollowGraphTopicSignalOptions {
  minFolloweeSample?: number
  minFolloweeLabeledRatio?: number
}

/**
 * @param signal - 対象ラベルの `bundle.followGraphLabelSignals` エントリ
 * @param options - しきい値の上書き（省略時はデフォルトのしきい値を使う）
 * @returns フォロー先側のサンプル数・ラベル済み比率がしきい値を満たすか
 */
export function hasFollowGraphTopicSignal(
  signal: FollowGraphLabelSignal | undefined,
  options: FollowGraphTopicSignalOptions = {},
): boolean {
  if (!signal) return false
  const minSample = options.minFolloweeSample ?? MIN_FOLLOWEE_SAMPLE
  const minRatio = options.minFolloweeLabeledRatio ?? MIN_FOLLOWEE_LABELED_RATIO
  if (signal.followeeTotalCount < minSample) return false
  return signal.followeeLabeledCount / signal.followeeTotalCount >= minRatio
}
