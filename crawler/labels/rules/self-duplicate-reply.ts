import type { LabelRule } from '../types'
import { normalizeReplyText } from '../duplicate-reply-index'

// インプレッション稼ぎ(「インプレゾンビ」)アカウントは、
// 同一内容を単独ツイートと他者のバズ投稿への @リプライの両方として投稿し、
// 無関係な複数のスレッドにまたがってエンゲージメントを二重取りする。
// ペアの再現を要求することで、
// 自身のツイートがたまたま自分宛てに引用されただけの通常のケースを除外する。
const MIN_DUPLICATE_PAIRS = 2

export const selfDuplicateReplyRule: LabelRule = {
  key: 'self_duplicate_reply',
  description:
    '同一内容(URL/メンションを除去した上で比較)を単独ツイートとしても @リプライとしても繰り返し投稿している。インプレッション稼ぎ(「インプレゾンビ」)行為の特徴',
  version: '1.1.0',
  evaluate(bundle) {
    // A reply whose parent is one of this account's own tweets within the bundle is thread
    // narration (the author continuing their own post), not a reply hijacked under someone
    // else's viral tweet - the pattern this rule targets. Excluding those avoids flagging
    // ordinary corporate/personal accounts that repeat a tagline across a self-thread. A
    // parent tweet outside the bundle's recent window is treated as unknown and not excluded.
    const ownTweetIds = new Set(bundle.recentTweets.map((t) => t.id))
    const groups = new Map<string, { hasStandalone: boolean; hasReply: boolean }>()
    for (const tweet of bundle.recentTweets) {
      if (tweet.isRetweet) continue
      const isSelfThreadReply =
        tweet.isReply && tweet.inReplyToTweetId != null && ownTweetIds.has(tweet.inReplyToTweetId)
      if (isSelfThreadReply) continue
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
