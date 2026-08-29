import { combineAlternatives, combineRequired, rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'

const MIN_SAMPLE = 12
const MIN_EXTERNAL_REPLIES = 10
const REPLY_RATIO_THRESHOLD = 0.6
const PARENT_AUTHOR_COVERAGE_THRESHOLD = 0.8
const EXTERNAL_REPLY_RATIO_THRESHOLD = 0.8
const DISTINCT_PARENT_RATIO_THRESHOLD = 0.8
const LIFETIME_VELOCITY_THRESHOLD_PER_DAY = 15
const RECENT_VELOCITY_THRESHOLD_PER_DAY = 40
const MIN_AVERAGE_REPLY_LENGTH = 45
const MAX_QUESTION_RATIO = 0.3
const GENERIC_REACTION_RATIO_THRESHOLD = 0.5
const ABSTRACT_CLOSING_RATIO_THRESHOLD = 0.5
const ABSTRACT_CLOSING_PATTERN = /(?:たい|たくなる|気になる|想像して(?:る|いる))$/u

const GENERIC_REACTION_PATTERNS = [
  /(?:わかり|分かり|素敵|すご|大変|つら|辛|嬉し|お疲れ|本当|ほんと|めっちゃ|ですよね|ですね|だね|ますね|良かった|よかった|大事|大切|かもしれません)/u,
  /(?:本当|ほんと)に(?:すご|素敵|大変|つら|辛|嬉し|良|愛おし|尊|心)/u,
  /(?:すご|素敵|大変|つら|辛|嬉し|愛おし|たまらな|心に響|胸が熱|温かい気持ち)/u,
  /(?:わか|分か)(?:る|ります|るよね|りますよね)/u,
  /(?:大事|大切)だと思(?:う|います)/u,
  /(?:ですよね|ますよね|ですね)(?:[。！!…]|$)/u,
  /(?:信頼されてる証拠|関係性が伝わ|人柄が出)/u,
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

function hasGenericReaction(text: string): boolean {
  return GENERIC_REACTION_PATTERNS.some((pattern) => pattern.test(text))
}

function hasAbstractClosing(text: string): boolean {
  const normalized = normalizeReplyText(text).replaceAll(/[\p{P}\p{S}\s]+$/gu, '')
  return ABSTRACT_CLOSING_PATTERN.test(normalized)
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

export const genericReplyFarmingRule: LabelRule = {
  key: 'generic_reply_farming',
  description:
    '多数の異なる外部投稿へ、汎用的な評価・共感や抽象的な関心の締めを高頻度に繰り返す行動を検出する shadow ラベル。AI/LLM 利用そのものは推定しない',
  version: '0.1.0',
  evaluate(bundle) {
    const sampled = bundle.recentTweets
    const replyTweets = sampled.filter((tweet) => tweet.isReply)
    const resolvedReplyTweets = replyTweets.filter(
      (tweet) => tweet.inReplyToTweetId && tweet.parentTweetAuthorId,
    )
    const externalReplies = resolvedReplyTweets.filter(
      (tweet) => tweet.parentTweetAuthorId !== bundle.account.id,
    )
    const replyRatio = sampled.length > 0 ? replyTweets.length / sampled.length : 0
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
    const genericReactionRatio =
      normalizedExternalReplies.length > 0
        ? normalizedExternalReplies.filter((text) => hasGenericReaction(text)).length /
          normalizedExternalReplies.length
        : 0
    const abstractClosingRatio =
      normalizedExternalReplies.length > 0
        ? normalizedExternalReplies.filter((text) => hasAbstractClosing(text)).length /
          normalizedExternalReplies.length
        : 0
    const tweetsPerDay = averageTweetsPerDay(
      bundle.account.tweetCount,
      bundle.account.accountCreatedAt,
    )
    const recentTweetsPerDay = recentObservedTweetsPerDay(sampled)
    const isVerifiedBusiness = bundle.account.verifiedType === 'Business'
    const hasGenericStyle =
      genericReactionRatio >= GENERIC_REACTION_RATIO_THRESHOLD ||
      abstractClosingRatio >= ABSTRACT_CLOSING_RATIO_THRESHOLD

    const hasEnoughSample = sampled.length >= MIN_SAMPLE
    const evaluable =
      hasEnoughSample &&
      (replyRatio < REPLY_RATIO_THRESHOLD ||
        parentAuthorCoverage >= PARENT_AUTHOR_COVERAGE_THRESHOLD)
    const candidate =
      replyRatio >= REPLY_RATIO_THRESHOLD &&
      externalReplies.length >= MIN_EXTERNAL_REPLIES &&
      externalReplyRatio >= EXTERNAL_REPLY_RATIO_THRESHOLD &&
      distinctParentRatio >= DISTINCT_PARENT_RATIO_THRESHOLD &&
      tweetsPerDay >= LIFETIME_VELOCITY_THRESHOLD_PER_DAY &&
      recentTweetsPerDay >= RECENT_VELOCITY_THRESHOLD_PER_DAY &&
      averageReplyLength >= MIN_AVERAGE_REPLY_LENGTH &&
      questionRatio <= MAX_QUESTION_RATIO &&
      !isVerifiedBusiness
    const value = evaluable && candidate && hasGenericStyle

    const styleScore = combineAlternatives([
      rampScore(genericReactionRatio, GENERIC_REACTION_RATIO_THRESHOLD, 0.5),
      rampScore(abstractClosingRatio, ABSTRACT_CLOSING_RATIO_THRESHOLD, 0.5),
    ])
    const evidenceScore = combineRequired([
      rampScore(replyRatio, REPLY_RATIO_THRESHOLD, 0.4),
      rampScore(externalReplies.length, MIN_EXTERNAL_REPLIES, MIN_EXTERNAL_REPLIES),
      rampScore(externalReplyRatio, EXTERNAL_REPLY_RATIO_THRESHOLD, 0.2),
      rampScore(distinctParentRatio, DISTINCT_PARENT_RATIO_THRESHOLD, 0.2),
      rampScore(
        tweetsPerDay,
        LIFETIME_VELOCITY_THRESHOLD_PER_DAY,
        LIFETIME_VELOCITY_THRESHOLD_PER_DAY,
      ),
      rampScore(
        recentTweetsPerDay,
        RECENT_VELOCITY_THRESHOLD_PER_DAY,
        RECENT_VELOCITY_THRESHOLD_PER_DAY,
      ),
      rampScore(averageReplyLength, MIN_AVERAGE_REPLY_LENGTH, MIN_AVERAGE_REPLY_LENGTH),
      rampScore(questionRatio, MAX_QUESTION_RATIO, MAX_QUESTION_RATIO, 'lower-is-positive'),
      isVerifiedBusiness ? 0 : 1,
      styleScore,
    ])

    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      evaluable,
      reason:
        `tweetsPerDay=${tweetsPerDay.toFixed(1)}, recentTweetsPerDay=${recentTweetsPerDay.toFixed(1)}, ` +
        `replyRatio=${replyRatio.toFixed(2)}, parentAuthorCoverage=${parentAuthorCoverage.toFixed(2)}, ` +
        `externalReplies=${externalReplies.length}, externalReplyRatio=${externalReplyRatio.toFixed(2)}, ` +
        `distinctParentRatio=${distinctParentRatio.toFixed(2)}, avgReplyLength=${averageReplyLength.toFixed(1)}, ` +
        `questionRatio=${questionRatio.toFixed(2)}, genericReactionRatio=${genericReactionRatio.toFixed(2)}, ` +
        `abstractClosingRatio=${abstractClosingRatio.toFixed(2)}, verifiedBusiness=${isVerifiedBusiness} (n=${sampled.length})`,
    }
  },
}
