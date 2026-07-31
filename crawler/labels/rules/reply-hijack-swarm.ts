import type { LabelRule } from '../types'

const MIN_DISTINCT_AUTHORS = 5
// Raising `SIMILARITY_THRESHOLD` in reply-hijack-index.ts cannot on its own separate
// coordinated impression farming from a genuine mass reaction to a viral tweet: ordinary
// Japanese/English courtesy replies (condolences, wedding congratulations) measured HIGHER
// bigram-Jaccard similarity (0.36-0.46) than a confirmed spam exemplar (0.23),
// because a shared boilerplate phrase scores just as "similar" whether it is farmed or
// heartfelt. Swarm membership is therefore necessary but not sufficient, and this rule also
// requires the account's OWN recent activity to look low-effort and reply-only - a person
// posting a heartfelt congratulations reply is not, in general, also an account with no
// original tweets of its own.
const MIN_SAMPLE = 3
// The account's own tweets must literally BE replies, not merely "not original":
// `originalContentRatio` treats retweets as not original, so an ordinary retweet-consuming
// human (mostly reposting others, rarely writing anything, including a rare reply) passed
// that guard on their retweets alone - a 91% false-positive rate almost entirely of this
// shape. The genuine hijack-swarm archetype is specifically reply-heavy.
const REPLY_RATIO_THRESHOLD = 0.5

/**
 * Flags accounts that took part in a "reply-hijack swarm" - 5 or more distinct
 * accounts each posting a paraphrased-similar, low-effort reply to the same
 * high-engagement target tweet within a short window, farming impressions off
 * someone else's viral post. Swarm membership is driven by
 * `AccountFeatureBundle.replyHijackSwarmSize`, which is computed once per crawl/relabel
 * run from a shared corpus (see `buildReplyHijackIndex`), not per-rule - but membership
 * alone is not sufficient (see `REPLY_RATIO_THRESHOLD` above): this rule also
 * requires the account's own recent tweets to look reply-only/low-effort, since text
 * similarity between distinct authors cannot on its own distinguish coordinated farming
 * from a genuine mass reaction (e.g. condolences, congratulations) to the same tweet.
 */
export const replyHijackSwarmRule: LabelRule = {
  key: 'reply_hijack_swarm',
  description:
    '別々のアカウントが1件ずつ、似た言い回しの低努力リプライを1つの高エンゲージメントツイートに乗せてインプレッションを稼ぐ「一斉提灯リプライ」ネットワークの一員であり、かつ自身のアカウントもオリジナル投稿がほぼない低努力アカウントである',
  version: '1.3.0',
  evaluate(bundle) {
    const size = bundle.replyHijackSwarmSize ?? 0
    const isSwarmMember = size >= MIN_DISTINCT_AUTHORS

    const sampled = bundle.recentTweets
    const hasEnoughSample = sampled.length >= MIN_SAMPLE
    const replyRatio = sampled.length > 0 ? sampled.filter((t) => t.isReply).length / sampled.length : 0
    const looksReplyFocused = hasEnoughSample && replyRatio >= REPLY_RATIO_THRESHOLD

    const value = isSwarmMember && looksReplyFocused
    const confidence = value ? Math.min(1, size / 15) : 0

    return {
      value,
      confidence,
      reason: `replyHijackSwarmSize=${size}, replyRatio=${replyRatio.toFixed(2)} (n=${sampled.length})`,
    }
  },
}
