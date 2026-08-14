import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'

export const adPromotedRule: LabelRule = {
  key: 'ad_promoted',
  description:
    'Twitter 公式の有償プロモーション(「プロモツイート」)が付与されたツイートが直近に1件以上ある',
  version: '1.0.1',
  evaluate(bundle) {
    const promotedCount = bundle.recentTweets.filter((t) => t.isPromoted).length
    const value = promotedCount > 0

    return {
      value,
      confidence: toConfidence(value, value ? 1 : 0),
      reason: `promotedTweetCount=${promotedCount} (n=${bundle.recentTweets.length})`,
    }
  },
}
