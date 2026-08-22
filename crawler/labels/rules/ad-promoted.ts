import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'

export const adPromotedRule: LabelRule = {
  key: 'ad_promoted',
  description:
    'Twitter 公式の有償プロモーション(「プロモツイート」)が付与されたツイートが直近に1件以上ある',
  version: '1.1.0',
  evaluate(bundle) {
    const promotedCount = bundle.recentTweets.filter((t) => t.isPromoted).length
    const value = promotedCount > 0

    // recentTweets が未取得の場合、単に一致が無いだけの陰性とは区別する。
    const evaluable = value || isRecentTweetsEvaluable(bundle)
    return {
      value,
      confidence: toConfidence(value, value ? 1 : 0, evaluable),
      reason: `promotedTweetCount=${promotedCount} (n=${bundle.recentTweets.length})`,
      evaluable,
    }
  },
}
