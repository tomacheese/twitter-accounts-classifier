import { combineRequired, rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// 大量生産型ではない低頻度アカウントを対象とするため、
// `generic_reply_farming`/`reply_farming` の高頻度閾値とは独立した (むしろ逆方向の) 閾値を持つ。
const MIN_SAMPLE = 15
const MIN_EXTERNAL_REPLIES = 4
const PARENT_AUTHOR_COVERAGE_THRESHOLD = 0.8
const EXTERNAL_REPLY_RATIO_THRESHOLD = 0.8
const DISTINCT_PARENT_RATIO_THRESHOLD = 0.8
// 本番観測例 (lifetime≈3.4/day, recent≈2.2/day) に対して十分な余裕を残しつつ、
// 高頻度リプライボットの領域とは重ならない上限にする。
const LIFETIME_VELOCITY_MAX_PER_DAY = 8
const RECENT_VELOCITY_MAX_PER_DAY = 8
const MIN_AVERAGE_REPLY_LENGTH = 55
const MAX_QUESTION_RATIO = 0.3
const MIN_SELF_POSITIONING_COUNT = 3
const SELF_POSITIONING_RATIO_THRESHOLD = 0.5

// 特定の話題語 (育児など) にはハードコードせず、
// 「自分も」型の自己包含と「〜として/〜の立場では/〜からすると」型の自己ポジショニングという、
// 話題に依存しない日本語の構文パターンのみで検出する。
const SELF_POSITIONING_PATTERNS = [
  /(?:自分|私|僕|わたし|ぼく)も/u,
  /(?:自分|私|僕|わたし|ぼく)(?:の立場では|からすると|からすれば|としても|として)/u,
]

function normalizeReplyText(text: string): string {
  return text
    .replaceAll(/https?:\/\/\S+/gu, ' ')
    .replaceAll(/@[A-Za-z0-9_]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()
}

function codePointLength(text: string): number {
  return text.match(/./gu)?.length ?? 0
}

function hasSelfPositioning(text: string): boolean {
  return SELF_POSITIONING_PATTERNS.some((pattern) => pattern.test(text))
}

function averageTweetsPerDay(tweetCount: number, accountCreatedAt: Date): number {
  const ageDays = Math.max(1, (Date.now() - accountCreatedAt.getTime()) / 86_400_000)
  return tweetCount / ageDays
}

function recentObservedTweetsPerDay(tweets: { createdAt: Date }[]): number {
  if (tweets.length < 2) return 0
  const timestamps = tweets.map((tweet) => tweet.createdAt.getTime())
  const spanDays = Math.max(
    (Math.max(...timestamps) - Math.min(...timestamps)) / 86_400_000,
    1 / 24,
  )
  return (tweets.length - 1) / spanDays
}

export const contextualReplyMarketingRule: LabelRule = {
  key: 'contextual_reply_marketing',
  description:
    '大量投稿ボットではない低頻度アカウントが、異なる外部投稿へ文脈に沿った長めの共感/称賛リプライを置きつつ、' +
    '「自分も」「〜として」「自分の立場では」等の自己ポジショニングを反復してプロフィール流入を狙う行動を検出する。' +
    'AI/LLM 利用そのものは推定しない',
  version: '0.1.0',
  excludeFromStaleScan: true,
  evaluate(bundle) {
    const sampled = bundle.recentTweets
    const replyTweets = sampled.filter((tweet) => tweet.isReply)
    const resolvedReplyTweets = replyTweets.filter(
      (tweet) => tweet.inReplyToTweetId && tweet.parentTweetAuthorId,
    )
    const externalReplies = resolvedReplyTweets.filter(
      (tweet) => tweet.parentTweetAuthorId !== bundle.account.id,
    )
    const parentAuthorCoverage =
      replyTweets.length > 0 ? resolvedReplyTweets.length / replyTweets.length : 1
    const externalReplyRatio =
      replyTweets.length > 0 ? externalReplies.length / replyTweets.length : 0
    const distinctParentRatio =
      externalReplies.length > 0
        ? new Set(externalReplies.map((tweet) => tweet.inReplyToTweetId)).size /
          externalReplies.length
        : 0
    const normalizedExternalReplies = externalReplies.map((tweet) =>
      normalizeReplyText(tweet.fullText),
    )
    const averageReplyLength =
      normalizedExternalReplies.length > 0
        ? normalizedExternalReplies.reduce((sum, text) => sum + codePointLength(text), 0) /
          normalizedExternalReplies.length
        : 0
    const questionRatio =
      normalizedExternalReplies.length > 0
        ? normalizedExternalReplies.filter((text) => /[?？]/u.test(text)).length /
          normalizedExternalReplies.length
        : 0
    const selfPositioningCount = normalizedExternalReplies.filter((text) =>
      hasSelfPositioning(text),
    ).length
    const selfPositioningRatio =
      normalizedExternalReplies.length > 0
        ? selfPositioningCount / normalizedExternalReplies.length
        : 0
    const tweetsPerDay = averageTweetsPerDay(
      bundle.account.tweetCount,
      bundle.account.accountCreatedAt,
    )
    const recentTweetsPerDay = recentObservedTweetsPerDay(sampled)
    const isVerifiedBusiness =
      bundle.account.verifiedType === 'Business' || bundle.account.professionalType === 'Business'

    const hasEnoughSample = sampled.length >= MIN_SAMPLE
    const evaluable = hasEnoughSample && parentAuthorCoverage >= PARENT_AUTHOR_COVERAGE_THRESHOLD
    const candidate =
      externalReplies.length >= MIN_EXTERNAL_REPLIES &&
      externalReplyRatio >= EXTERNAL_REPLY_RATIO_THRESHOLD &&
      distinctParentRatio >= DISTINCT_PARENT_RATIO_THRESHOLD &&
      tweetsPerDay <= LIFETIME_VELOCITY_MAX_PER_DAY &&
      recentTweetsPerDay <= RECENT_VELOCITY_MAX_PER_DAY &&
      averageReplyLength >= MIN_AVERAGE_REPLY_LENGTH &&
      questionRatio <= MAX_QUESTION_RATIO &&
      selfPositioningCount >= MIN_SELF_POSITIONING_COUNT &&
      selfPositioningRatio >= SELF_POSITIONING_RATIO_THRESHOLD &&
      !isVerifiedBusiness
    const value = evaluable && candidate

    const evidenceScore = combineRequired([
      rampScore(externalReplies.length, MIN_EXTERNAL_REPLIES, MIN_EXTERNAL_REPLIES),
      rampScore(externalReplyRatio, EXTERNAL_REPLY_RATIO_THRESHOLD, 0.2),
      rampScore(distinctParentRatio, DISTINCT_PARENT_RATIO_THRESHOLD, 0.2),
      rampScore(
        tweetsPerDay,
        LIFETIME_VELOCITY_MAX_PER_DAY,
        LIFETIME_VELOCITY_MAX_PER_DAY,
        'lower-is-positive',
      ),
      rampScore(
        recentTweetsPerDay,
        RECENT_VELOCITY_MAX_PER_DAY,
        RECENT_VELOCITY_MAX_PER_DAY,
        'lower-is-positive',
      ),
      rampScore(averageReplyLength, MIN_AVERAGE_REPLY_LENGTH, MIN_AVERAGE_REPLY_LENGTH),
      rampScore(questionRatio, MAX_QUESTION_RATIO, MAX_QUESTION_RATIO, 'lower-is-positive'),
      rampScore(selfPositioningCount, MIN_SELF_POSITIONING_COUNT, MIN_SELF_POSITIONING_COUNT),
      rampScore(selfPositioningRatio, SELF_POSITIONING_RATIO_THRESHOLD, 0.5),
      isVerifiedBusiness ? 0 : 1,
    ])

    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      evaluable,
      reason:
        `tweetsPerDay=${tweetsPerDay.toFixed(1)}, recentTweetsPerDay=${recentTweetsPerDay.toFixed(1)}, ` +
        `parentAuthorCoverage=${parentAuthorCoverage.toFixed(2)}, externalReplies=${externalReplies.length}, ` +
        `externalReplyRatio=${externalReplyRatio.toFixed(2)}, distinctParentRatio=${distinctParentRatio.toFixed(2)}, ` +
        `avgReplyLength=${averageReplyLength.toFixed(1)}, questionRatio=${questionRatio.toFixed(2)}, ` +
        `selfPositioningCount=${selfPositioningCount}, selfPositioningRatio=${selfPositioningRatio.toFixed(2)}, ` +
        `verifiedBusiness=${isVerifiedBusiness} (n=${sampled.length})`,
    }
  },
}
