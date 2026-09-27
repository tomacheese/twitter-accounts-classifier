import { posteriorProbabilityAtLeast, toConfidence } from '../confidence'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'
import { hasLinguisticContent } from '../text-similarity'
import type { LabelRule } from '../types'

// amazon_affiliate_link・scam_link_domain のようなドメイン限定判定とは独立に、
// リンク先を問わず「コメントなしリンクの連投」そのものを spam パターンとして検出する。
const MIN_SAMPLE = 5
const BARE_LINK_RATIO_THRESHOLD = 0.6

function hasUrl(tweet: { expandedUrls?: string[]; fullText: string }): boolean {
  return (tweet.expandedUrls?.length ?? 0) > 0 || /https?:\/\/\S+/.test(tweet.fullText)
}

export const bareLinkSpamRule: LabelRule = {
  key: 'bare_link_spam',
  description:
    '自身のメディアなし投稿の大半が、URL・メンション除去後のテキストが実質空になる、コメントなしリンクの連投である。リンク先ドメインを問わない汎用的な spam パターン',
  version: '1.1.0',
  evaluate(bundle) {
    const observedOwnPosts = bundle.recentTweets.filter((t) => !t.isReply && !t.isRetweet)
    const ownPosts = observedOwnPosts.filter((t) => t.hasMedia === false)
    const bareLinkPosts = ownPosts.filter((t) => hasUrl(t) && !hasLinguisticContent(t.fullText))

    // 単発の閾値越えによる誤検知を避けるため、
    // 「一致が1件あるかどうか」より多いサンプル数を要求する。
    const hasEnoughSample = ownPosts.length >= MIN_SAMPLE
    const ratio = ownPosts.length > 0 ? bareLinkPosts.length / ownPosts.length : 0
    const evidenceScore = hasEnoughSample
      ? posteriorProbabilityAtLeast(
          bareLinkPosts.length,
          ownPosts.length,
          BARE_LINK_RATIO_THRESHOLD,
        )
      : 0

    // recentTweets が未取得の場合、単に投稿数が少ないだけの陰性とは区別する。
    const allObservedPostsWereMedia =
      observedOwnPosts.length > 0 && observedOwnPosts.every((tweet) => tweet.hasMedia === true)
    const allObservedMediaStatusKnown = observedOwnPosts.every(
      (tweet) => tweet.hasMedia !== null && tweet.hasMedia !== undefined,
    )
    const evaluable =
      isRecentTweetsEvaluable(bundle) &&
      allObservedMediaStatusKnown &&
      (hasEnoughSample || allObservedPostsWereMedia)
    const value = evaluable && hasEnoughSample && ratio >= BARE_LINK_RATIO_THRESHOLD
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bareLinkRatio=${ratio.toFixed(2)} (n=${bareLinkPosts.length}/${ownPosts.length})`,
      evaluable,
    }
  },
}
