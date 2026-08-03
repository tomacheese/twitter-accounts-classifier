import type { LabelRule } from '../types'

// オリジナル投稿が一切なく、直近のツイートがすべてリプライまたはリツイートで、
// 人間としてあり得ない頻度で投稿するアーキタイプは、
// `bot` ルールの「返信比率がほぼゼロ」の分岐と表裏一体だが、
// `bot` ルールの頻度・間隔の規則性という意味論を無関係な受け皿にしないよう、
// あえて独立したラベルとして扱う。
const VELOCITY_THRESHOLD_PER_DAY = 150
// `bot` ルールと同じ裏付けを要求している。
// 何年も前から稼働する大規模な認証済みビジネスアカウントは、
// X 側の `statuses_count` が実際の投稿頻度に対して大幅に水増しされていることがあるため、
// `tweetCount / accountAge` のみでは高頻度アカウントと誤判定してしまう。
const RECENT_VELOCITY_CORROBORATION_THRESHOLD_PER_DAY = 50
const MIN_SAMPLE = 5
const ORIGINAL_CONTENT_RATIO_THRESHOLD = 0.05
// `originalContentRatio` はリツイートも「オリジナルでない」とみなすため、
// 一日中転載するだけで返信しない純粋なリツイート主体アカウントもこのガードを素通りしてしまう。
// アカウント自身の投稿が実際に返信であることを要求することで、
// 両者を明確に区別する。
const REPLY_RATIO_THRESHOLD = 0.5

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
    // `bot` ルールと同様、直近の投稿頻度が高いだけでは十分条件とせず、
    // 生涯平均も同時に満たす必要がある。
    // 短時間のサンプルから「1日あたり」の頻度を外挿すると、
    // 実況などで密集投稿する人間の生涯平均は bot 的でなくても閾値を容易に超えてしまうため。
    const isHighVelocity =
      tweetsPerDay >= VELOCITY_THRESHOLD_PER_DAY &&
      recentTweetsPerDay >= RECENT_VELOCITY_CORROBORATION_THRESHOLD_PER_DAY

    const originalTweets = sampled.filter((t) => !t.isReply && !t.isRetweet)
    const originalContentRatio = sampled.length > 0 ? originalTweets.length / sampled.length : 1
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
