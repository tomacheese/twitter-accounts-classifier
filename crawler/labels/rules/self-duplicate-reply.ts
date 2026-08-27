import { rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'
import { normalizeReplyText } from '../duplicate-reply-index'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'

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
  version: '1.4.0',
  evaluate(bundle) {
    // リプライ先が自分自身の直近ツイートである場合、それは他者のバズ投稿に相乗りした
    // リプライではなく、自分の投稿を続けるスレッド内の連投にすぎない。
    // これを除外しないと、定型の宣伝文句をスレッド内で繰り返すだけの
    // 通常の法人・個人アカウントを誤検知してしまう。
    // リプライ先が直近ツイートの範囲外にある場合は判定不能として除外しない。
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
    const evidenceScore = rampScore(duplicatePairs, MIN_DUPLICATE_PAIRS, 2, 'higher-is-positive')
    // ツイートが一件も無い、または取得が未完了・失敗して一部だけ残存している場合、
    // 重複が存在しないと確認できたのではなく単に判定材料がないだけである。
    // 他のツイート依存ルールと同様に evaluable: false として区別する。
    const evaluable = bundle.recentTweets.length > 0 && isRecentTweetsEvaluable(bundle)
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `selfDuplicatePostReplyPairs=${duplicatePairs}`,
      evaluable,
    }
  },
}
