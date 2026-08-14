import { toConfidence } from '../confidence'
import type { LabelRule } from '../types'

export const videoRepostRule: LabelRule = {
  key: 'video_repost',
  description: '他者アカウントを動画の出典として X が示す動画を再利用している',
  version: '2.0.1',
  evaluate(bundle) {
    const candidates = bundle.recentTweets.filter(
      (tweet) => !tweet.isRetweet && (tweet.foreignVideoSourceCount ?? 0) > 0,
    )
    const value = candidates.length >= 3

    return {
      value,
      confidence: toConfidence(value, value ? 1 : 0),
      reason: `foreignVideoPostCount=${candidates.length} (n=${bundle.recentTweets.length})`,
    }
  },
}
