import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'

// 「直近」を件数ではなく期間で定義する。投稿頻度の高いアカウントでも古いプロモ履歴が件数で押し出されないようにする。
// 日数は本番影響評価で確定するまでの暫定値であり、件数の DB 集計と共有する。
export const PROMOTED_RECENT_WINDOW_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

export const adPromotedRule: LabelRule = {
  key: 'ad_promoted',
  description:
    'Twitter 公式の有償プロモーション(「プロモツイート」)が付与されたツイートが直近 30 日以内に1件以上ある。直近ツイートの取得件数上限を超えた期間内のプロモツイートも、DB 集計値で数える',
  version: '1.3.0',
  evaluate(bundle) {
    const since = Date.now() - PROMOTED_RECENT_WINDOW_DAYS * DAY_MS
    const windowTweets = bundle.recentTweets.filter((t) => t.createdAt.getTime() >= since)
    const promotedCount = windowTweets.filter((t) => t.isPromoted).length
    // recentTweets は件数上限で切られているため、期間内の古いプロモ投稿は DB 集計値で補う。
    const promotedCountInWindow = bundle.promotedTweetCountInWindow ?? 0
    const value = promotedCount > 0 || promotedCountInWindow > 0

    // recentTweets が未取得の場合、単に一致が無いだけの陰性とは区別する。
    const evaluable = value || isRecentTweetsEvaluable(bundle)
    return {
      value,
      confidence: toConfidence(value, value ? 1 : 0, evaluable),
      reason: `promotedTweetCount=${promotedCount}, promotedTweetCountInWindow=${promotedCountInWindow} (n=${windowTweets.length})`,
      evaluable,
    }
  },
}
