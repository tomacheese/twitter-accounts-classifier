import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'

export const videoRepostRule: LabelRule = {
  key: 'video_repost',
  description: '他者アカウントを動画の出典として X が示す動画を再利用している',
  version: '2.1.0',
  evaluate(bundle) {
    const candidates = bundle.recentTweets.filter(
      (tweet) => !tweet.isRetweet && (tweet.foreignVideoSourceCount ?? 0) > 0,
    )
    const value = candidates.length >= 3

    // recentTweets が未取得の場合、単に一致が無いだけの陰性とは区別する。
    const evaluable = value || isRecentTweetsEvaluable(bundle)
    return {
      value,
      confidence: toConfidence(value, value ? 1 : 0, evaluable),
      reason: `foreignVideoPostCount=${candidates.length} (n=${bundle.recentTweets.length})`,
      evaluable,
    }
  },
}
