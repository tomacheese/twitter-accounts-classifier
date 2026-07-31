import type { LabelRule } from '../types'
import { normalizeReplyText } from '../duplicate-reply-index'

// Impression-farming ("インプレゾンビ") accounts post identical content both as a standalone
// tweet and as an @-reply under someone else's viral tweet, double-dipping engagement across
// many unrelated threads. Requiring the pair to recur rules out the ordinary case of a single
// tweet that happens to be quoted back at its own author.
const MIN_DUPLICATE_PAIRS = 2

export const selfDuplicateReplyRule: LabelRule = {
  key: 'self_duplicate_reply',
  description:
    '同一内容(URL/メンションを除去した上で比較)を単独ツイートとしても @リプライとしても繰り返し投稿している。インプレッション稼ぎ(「インプレゾンビ」)行為の特徴',
  version: '1.0.0',
  evaluate(bundle) {
    const groups = new Map<string, { hasStandalone: boolean; hasReply: boolean }>()
    for (const tweet of bundle.recentTweets) {
      if (tweet.isRetweet) continue
      const normalized = normalizeReplyText(tweet.fullText)
      if (normalized === '') continue
      const group = groups.get(normalized) ?? { hasStandalone: false, hasReply: false }
      if (tweet.isReply) {
        group.hasReply = true
      } else {
        group.hasStandalone = true
      }
      groups.set(normalized, group)
    }

    let duplicatePairs = 0
    for (const group of groups.values()) {
      if (group.hasStandalone && group.hasReply) duplicatePairs++
    }

    const value = duplicatePairs >= MIN_DUPLICATE_PAIRS
    return {
      value,
      confidence: value ? Math.min(1, duplicatePairs / 4) : 0,
      reason: `selfDuplicatePostReplyPairs=${duplicatePairs}`,
    }
  },
}
