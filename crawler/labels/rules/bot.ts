import type { LabelRule } from '../types'

const VELOCITY_THRESHOLD_PER_DAY = 150
// Decade-old, large verified Business accounts can carry a `statuses_count` on X's own side
// that is wildly inflated relative to their actual posting cadence, so `tweetCount /
// accountAge` alone falsely flags them as high-velocity. Requiring the *observed* cadence
// within the sampled tweets to also clear a bar corroborates the lifetime-average signal
// instead of trusting it in isolation.
const RECENT_VELOCITY_CORROBORATION_THRESHOLD_PER_DAY = 50
const MIN_SAMPLE_FOR_TIMING_SIGNALS = 5
const REPLY_RATIO_THRESHOLD = 0.05
const INTERVAL_COEFFICIENT_OF_VARIATION_THRESHOLD = 0.2

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

function intervalCoefficientOfVariation(createdAtValues: Date[]): number {
  // eslint-disable-next-line unicorn/no-array-sort
  const sorted = [...createdAtValues].sort((a, b) => a.getTime() - b.getTime())
  const intervals: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    intervals.push(sorted[i].getTime() - sorted[i - 1].getTime())
  }
  if (intervals.length === 0) return Infinity
  const mean = intervals.reduce((sum, v) => sum + v, 0) / intervals.length
  if (mean === 0) return 0
  const variance = intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / intervals.length
  return Math.sqrt(variance) / mean
}

export const botRule: LabelRule = {
  key: 'bot',
  description:
    '投稿頻度が人間としてあり得ない速さであり、かつリプライ比率がほぼゼロで、投稿間隔が機械的なまでに規則的である',
  version: '1.4.0',
  evaluate(bundle) {
    const { tweetCount, accountCreatedAt } = bundle.account
    const sampled = bundle.recentTweets
    const tweetsPerDay = averageTweetsPerDay(tweetCount, accountCreatedAt)
    const recentTweetsPerDay = recentObservedTweetsPerDay(sampled)
    // Both rates must clear their bar; a high recent rate alone must never suffice.
    // `recentObservedTweetsPerDay` extrapolates a "per day" rate from however many tweets
    // were sampled, so for ordinary humans live-tweeting a short real-world event (a stream,
    // a game, a drama episode) a tight cluster of tweets routinely blows past 150/day even
    // though their lifetime average is nowhere near bot-like - a standalone recent-rate
    // branch measured a 94% false-positive rate, with no genuine bot depending on it.
    const isHighVelocity =
      tweetsPerDay >= VELOCITY_THRESHOLD_PER_DAY &&
      recentTweetsPerDay >= RECENT_VELOCITY_CORROBORATION_THRESHOLD_PER_DAY
    // The ratio is taken over original posts only. A retweet can never be a reply, so
    // counting retweets in the denominator pushes the ratio toward zero mechanically and
    // turns this signal into a proxy for "retweets a lot" rather than "never converses" -
    // Japanese X is full of prolific human retweeters (idol fandoms, 懸賞 accounts, political
    // repost accounts) who were flagged on that alone, with 0-4 original posts out of 20.
    const originalPosts = sampled.filter((t) => !t.isRetweet)
    const replyRatio =
      originalPosts.length > 0
        ? originalPosts.filter((t) => t.isReply).length / originalPosts.length
        : 1
    const hasNearZeroReplies =
      originalPosts.length >= MIN_SAMPLE_FOR_TIMING_SIGNALS && replyRatio < REPLY_RATIO_THRESHOLD

    const cov =
      sampled.length >= MIN_SAMPLE_FOR_TIMING_SIGNALS
        ? intervalCoefficientOfVariation(sampled.map((t) => t.createdAt))
        : Infinity
    const hasRegularIntervals = cov < INTERVAL_COEFFICIENT_OF_VARIATION_THRESHOLD

    const value = isHighVelocity && (hasNearZeroReplies || hasRegularIntervals)
    const signals = [isHighVelocity, hasNearZeroReplies, hasRegularIntervals].filter(Boolean).length
    const confidence = signals === 0 ? 0 : signals / 3

    return {
      value,
      confidence,
      reason: `tweetsPerDay=${tweetsPerDay.toFixed(1)}, recentTweetsPerDay=${recentTweetsPerDay.toFixed(1)}, replyRatio=${replyRatio.toFixed(2)} (originalPosts=${originalPosts.length}/${sampled.length}), intervalCoV=${Number.isFinite(cov) ? cov.toFixed(2) : 'n/a'}`,
    }
  },
}
