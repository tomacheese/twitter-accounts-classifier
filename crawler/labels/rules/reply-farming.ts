import type { LabelRule } from '../types'

// This archetype - no organic content at all, every recent tweet a reply or a retweet, at a
// velocity far beyond plausible human rates - is the mirror image of the `bot` rule's
// near-zero-reply-ratio branch. It is deliberately kept as its own label rather than folded
// into `bot`, so that rule's frequency-and-timing-regularity semantics do not turn into an
// unrelated catch-all.
const VELOCITY_THRESHOLD_PER_DAY = 150
// Same corroboration requirement as the `bot` rule: decade-old, large verified Business
// accounts can carry a `statuses_count` on X's own side that is wildly inflated relative to
// their actual posting cadence, so `tweetCount / accountAge` alone falsely flags them as
// high-velocity.
const RECENT_VELOCITY_CORROBORATION_THRESHOLD_PER_DAY = 50
const MIN_SAMPLE = 5
const ORIGINAL_CONTENT_RATIO_THRESHOLD = 0.05
// `originalContentRatio` counts retweets as "not original", so a pure retweeter - someone
// who reposts others all day and writes nothing, not even replies - scores 0 and clears that
// guard without ever having farmed a reply. Requiring the account's own tweets to actually
// BE replies separates the two cleanly: in the sampled corpus the false positives sat at a
// reply ratio of 0.10 or below and every genuine reply-farming account at exactly 1.00.
const REPLY_RATIO_THRESHOLD = 0.5

function averageTweetsPerDay(tweetCount: number, accountCreatedAt: Date): number {
  const ageMs = Date.now() - accountCreatedAt.getTime()
  const ageDays = Math.max(1, ageMs / (1000 * 60 * 60 * 24))
  return tweetCount / ageDays
}

function recentObservedTweetsPerDay(tweets: { createdAt: Date }[]): number {
  if (tweets.length < 2) return 0
  const timestamps = tweets.map((t) => t.createdAt.getTime())
  const spanDays = Math.max((Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60 * 24), 1 / 24)
  return (tweets.length - 1) / spanDays
}

export const replyFarmingRule: LabelRule = {
  key: 'reply_farming',
  description:
    '自身によるオリジナル投稿が一切なく(直近のツイートがすべてリプライまたはリツイート)、かつ人間としてあり得ない投稿頻度である。大量生産型の AI 生成/エンゲージメント稼ぎリプライボットの特徴',
  version: '1.4.0',
  evaluate(bundle) {
    const { tweetCount, accountCreatedAt } = bundle.account
    const sampled = bundle.recentTweets
    const tweetsPerDay = averageTweetsPerDay(tweetCount, accountCreatedAt)
    const recentTweetsPerDay = recentObservedTweetsPerDay(sampled)
    // As in the `bot` rule, a high recent rate alone must never suffice: extrapolating a
    // "per day" rate from a short burst of sampled tweets routinely exceeds 150/day for
    // ordinary humans live-tweeting an event, even though their lifetime posting average is
    // nowhere near bot-like (a standalone recent-rate branch measured 91% false positives,
    // with no confirmed reply-farming account depending on it).
    const isHighVelocity =
      tweetsPerDay >= VELOCITY_THRESHOLD_PER_DAY &&
      recentTweetsPerDay >= RECENT_VELOCITY_CORROBORATION_THRESHOLD_PER_DAY

    const originalTweets = sampled.filter((t) => !t.isReply && !t.isRetweet)
    const originalContentRatio =
      sampled.length > 0 ? originalTweets.length / sampled.length : 1
    const hasEnoughSample = sampled.length >= MIN_SAMPLE
    const hasNoOriginalContent =
      hasEnoughSample && originalContentRatio <= ORIGINAL_CONTENT_RATIO_THRESHOLD

    const replyRatio =
      sampled.length > 0 ? sampled.filter((t) => t.isReply).length / sampled.length : 0
    const looksReplyFocused = hasEnoughSample && replyRatio >= REPLY_RATIO_THRESHOLD

    const value = isHighVelocity && hasNoOriginalContent && looksReplyFocused

    return {
      value,
      confidence: value ? 1 - originalContentRatio : 0,
      reason: `tweetsPerDay=${tweetsPerDay.toFixed(1)}, recentTweetsPerDay=${recentTweetsPerDay.toFixed(1)}, originalContentRatio=${originalContentRatio.toFixed(2)}, replyRatio=${replyRatio.toFixed(2)} (n=${sampled.length})`,
    }
  },
}
