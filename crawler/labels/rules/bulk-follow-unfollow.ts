import { rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// 14日間で12回もの完全な follow→unfollow サイクルを閉じることは、
// キュレーション目的の通常利用では通常考えにくい。
const MIN_COMPLETED_CYCLES = 12
// completedCycles=0 は「churn が無かった」のか「観測機会自体が無かった」のか
// 区別できないため、最低限の生イベント数を要求する。
const MIN_EVENTS_FOR_EVALUATION = 4

export const bulkFollowUnfollowRule: LabelRule = {
  key: 'bulk_follow_unfollow',
  description:
    '観測期間内にフォロー→アンフォローの完全なサイクルを繰り返しており、' +
    'X の Developer Policy が禁止する bulk following の典型パターンと一致する',
  version: '1.0.0',
  excludeFromStaleScan: true,
  evaluate(bundle) {
    const observation = bundle.followChurnObservation
    const completedCycles = observation?.completedCycles ?? 0
    const totalEvents = (observation?.followed ?? 0) + (observation?.unfollowed ?? 0)
    const value = completedCycles >= MIN_COMPLETED_CYCLES
    const evidenceScore = rampScore(
      completedCycles,
      MIN_COMPLETED_CYCLES,
      MIN_COMPLETED_CYCLES,
      'higher-is-positive',
    )
    const evaluable = value || totalEvents >= MIN_EVENTS_FOR_EVALUATION
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `completedCycles=${completedCycles}, followed=${observation?.followed ?? 0}, unfollowed=${observation?.unfollowed ?? 0}`,
      evaluable,
    }
  },
}
