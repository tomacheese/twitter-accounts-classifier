import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'

export const videoRepostRule: LabelRule = {
  key: 'video_repost',
  description: '他者アカウントを動画の出典として X が示す動画を再利用している',
  version: '2.2.0',
  evaluate(bundle) {
    const ownTweets = bundle.recentTweets.filter((tweet) => !tweet.isRetweet)
    const candidates = ownTweets.filter((tweet) => (tweet.foreignVideoSourceCount ?? 0) > 0)
    const unaggregatedCount = ownTweets.filter(
      (tweet) => tweet.foreignVideoSourceCount == null,
    ).length
    const value = candidates.length >= 3

    // recentTweets が未取得の場合、単に一致が無いだけの陰性とは区別する。
    // 出典数が未集計の投稿を全て該当と仮定すると閾値に届く場合は、陰性と断定しない。
    const evaluable =
      value || (isRecentTweetsEvaluable(bundle) && candidates.length + unaggregatedCount < 3)
    return {
      value,
      confidence: toConfidence(value, value ? 1 : 0, evaluable),
      reason: `foreignVideoPostCount=${candidates.length} (n=${bundle.recentTweets.length})`,
      evaluable,
    }
  },
}
