import type { LabelRule } from '../types'

const VELOCITY_THRESHOLD_PER_DAY = 150
// 何年も前から稼働する大規模な認証済みビジネスアカウントは、
// X 側の `statuses_count` が実際の投稿頻度に対して大幅に水増しされていることがあるため、
// `tweetCount / accountAge` のみでは高頻度アカウントと誤判定してしまう。
// サンプルした直近ツイートの実測頻度にも基準を課すことで、
// 生涯平均の水増しに単独で依拠しないようにしている。
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
  const spanDays = Math.max(
    (Math.max(...timestamps) - Math.min(...timestamps)) / (1000 * 60 * 60 * 24),
    1 / 24,
  )
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
  version: '1.5.0',
  evaluate(bundle) {
    const { tweetCount, accountCreatedAt } = bundle.account
    const sampled = bundle.recentTweets
    const tweetsPerDay = averageTweetsPerDay(tweetCount, accountCreatedAt)
    const recentTweetsPerDay = recentObservedTweetsPerDay(sampled)
    // 直近の投稿頻度が高いだけでは十分条件とせず、
    // 生涯平均も同時に満たす必要がある。
    // `recentObservedTweetsPerDay` はサンプルした件数から「1日あたり」の頻度を外挿するため、
    // 配信・ゲーム実況・ドラマ視聴などの短時間の実況で密集投稿する人間は、
    // 生涯平均が bot 的でなくても閾値を容易に超えてしまう。
    const isHighVelocity =
      tweetsPerDay >= VELOCITY_THRESHOLD_PER_DAY &&
      recentTweetsPerDay >= RECENT_VELOCITY_CORROBORATION_THRESHOLD_PER_DAY
    // 比率はオリジナル投稿のみを対象とする。リツイートは返信になり得ないため、
    // 分母にリツイートを含めると比率が機械的にゼロへ寄ってしまい、
    // この信号が「会話しないこと」ではなく「リツイートが多いこと」の代理指標になってしまう。
    // 日本語 X には多数リツイートする人間アカウント(推し活・懸賞・政治系の転載など)が多く、
    // これらを誤検知しないためである。
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

    // どちらか一方の副次シグナルだけで確定させると、
    // 返信をしない代わりに不定期に投稿する公式ブランド・メディアアカウント
    // (スケジュール投稿ツール運用でも間隔は人手の更新ペースに揺らぐ)を bot 誤判定してしまう。
    // description が謳う「機械的に規則的な間隔」も併せて満たす場合のみ確定させる。
    const value = isHighVelocity && hasNearZeroReplies && hasRegularIntervals
    const signals = [isHighVelocity, hasNearZeroReplies, hasRegularIntervals].filter(Boolean).length
    const confidence = signals === 0 ? 0 : signals / 3

    return {
      value,
      confidence,
      reason: `tweetsPerDay=${tweetsPerDay.toFixed(1)}, recentTweetsPerDay=${recentTweetsPerDay.toFixed(1)}, replyRatio=${replyRatio.toFixed(2)} (originalPosts=${originalPosts.length}/${sampled.length}), intervalCoV=${Number.isFinite(cov) ? cov.toFixed(2) : 'n/a'}`,
    }
  },
}
