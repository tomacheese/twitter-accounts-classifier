import { posteriorProbabilityAtLeast } from './confidence'
import type { FollowGraphLabelSignal } from './follow-graph-label-index'

// サンプルの分母がこれ未満では少数の偶然の一致で発火してしまうため、この値を下限とする。
const MIN_FOLLOWEE_SAMPLE = 15
// フォロー先の3割以上が該当ラベルを持つ場合のみ、その関心を強い関連性とみなす。
const MIN_FOLLOWEE_LABELED_RATIO = 0.3

export interface FollowGraphTopicSignalOptions {
  minFolloweeSample?: number
  minFolloweeLabeledRatio?: number
}

export interface FollowGraphTopicSignalResult {
  /** 既存と同じ判定: totalCount >= MIN_FOLLOWEE_SAMPLE && labeledCount / totalCount >= MIN_FOLLOWEE_LABELED_RATIO。 */
  matched: boolean
  /** totalCount < MIN_FOLLOWEE_SAMPLE の場合は 0。それ以外は posteriorProbabilityAtLeast(labeledCount, totalCount, MIN_FOLLOWEE_LABELED_RATIO)。 */
  evidenceScore: number
  /** totalCount >= MIN_FOLLOWEE_SAMPLE かどうか。follow graph 単独で判定材料になり得るかを表す。 */
  evaluable: boolean
}

/**
 * @param signal - 対象ラベルの `bundle.followGraphLabelSignals` エントリ
 * @param options - しきい値の上書き（省略時はデフォルトのしきい値を使う）
 * @returns フォロー先側のサンプル数・ラベル済み比率に基づく matched/evidenceScore/evaluable
 */
export function hasFollowGraphTopicSignal(
  signal: FollowGraphLabelSignal | undefined,
  options: FollowGraphTopicSignalOptions = {},
): FollowGraphTopicSignalResult {
  const minSample = options.minFolloweeSample ?? MIN_FOLLOWEE_SAMPLE
  const minRatio = options.minFolloweeLabeledRatio ?? MIN_FOLLOWEE_LABELED_RATIO
  if (!signal || signal.followeeTotalCount < minSample) {
    return { matched: false, evidenceScore: 0, evaluable: false }
  }
  const matched = signal.followeeLabeledCount / signal.followeeTotalCount >= minRatio
  const evidenceScore = posteriorProbabilityAtLeast(
    signal.followeeLabeledCount,
    signal.followeeTotalCount,
    minRatio,
  )
  return { matched, evidenceScore, evaluable: true }
}
