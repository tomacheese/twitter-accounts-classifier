import { combineRequired, rampScore, toConfidence } from '../confidence'
import type { LabelRule } from '../types'

// 大量生産型ではない低頻度アカウントを対象とするため、
// `generic_reply_farming`/`reply_farming` の高頻度閾値とは独立した (むしろ逆方向の) 閾値を持つ。
const MIN_SAMPLE = 15
const MIN_EXTERNAL_REPLIES = 4
const PARENT_AUTHOR_COVERAGE_THRESHOLD = 0.8
const EXTERNAL_REPLY_RATIO_THRESHOLD = 0.8
const DISTINCT_PARENT_RATIO_THRESHOLD = 0.8
const MIN_DISTINCT_PARENT_AUTHORS = 4
const DISTINCT_PARENT_AUTHOR_RATIO_THRESHOLD = 0.8
// 低頻度アカウントの生活リズムの揺らぎを許容しつつ、高頻度リプライボットの領域とは重ならない上限にする。
// 直近速度は短期的に加速し得るため、hard gate では lifetime 側だけで頻度を絞る。
const LIFETIME_VELOCITY_MAX_PER_DAY = 8
const MIN_AVERAGE_REPLY_LENGTH = 55
const MAX_QUESTION_RATIO = 0.3
const MIN_SELF_POSITIONING_COUNT = 3
const SELF_POSITIONING_RATIO_THRESHOLD = 0.5

// value/evaluable には使わず、hard gate を通過した陽性だけの confidence を補強する soft signal。
const GENERIC_REACTION_RATIO_SOFT_THRESHOLD = 0.6
const ORIGINAL_EXTERNAL_URL_RATIO_SOFT_THRESHOLD = 0.3
const NEW_ACCOUNT_AGE_DAYS_SOFT_THRESHOLD = 180
const SOFT_CONFIDENCE_MAX_BONUS = 0.1

// 特定の話題語 (育児など) にはハードコードせず、
// 「自分も」型の自己包含、「〜として/〜の立場では/〜からすると」型の自己ポジショニング、
// 「自分は以前/自分は…以前〜を経験/使っている/やっていた」型の自己経験ブリッジという、
// 話題に依存しない日本語・中国語の構文パターンのみで検出する。
// 「自分は」単独だと一般的な第一人称の発言まで拾うため、経験を示す語と組み合わせた形のみを対象にする。
// 「以前〜を経験」単独は三人称の経験談とも区別できないため、一人称語の近傍にある場合のみ対象にする。
const SELF_POSITIONING_PATTERNS = [
  /(?:自分|私|僕|わたし|ぼく)も/u,
  /(?:自分|私|僕|わたし|ぼく)(?:の立場では|からすると|からすれば|としても|として)/u,
  /(?:自分|私|僕|わたし|ぼく)は(?:以前|昔)/u,
  // 三人称の経験談との区別のため、一人称語が近傍にある場合のみ自己経験ブリッジとして扱う。
  // 「自分の同僚が/自分の友人が」のような所属格越しの第三者主語を除外する。
  // 一人称語の直後が「の…が/は」になる所有格用法は、自己が主語/話題ではない。
  // 節中に別の主語 (Xが/Xは) が挟まる非所有格の第三者言及も除外する。
  // 一人称語直後以外での「が」「は」の出現を禁じる。
  // 「以前」より後ろに現れる第三者主語 (Xが/Xは) も同様に経験の主体を入れ替えるため、
  // 「以前」と「経験」のあいだでも「が」「は」の出現を禁じる。
  /(?:自分|私|僕|わたし|ぼく)(?!の[^。、]{0,10}(?:が|は))(?:が|は|も)?[^。、がは]{0,20}以前[^。、がは]{0,20}経験/u,
  // 「使っている/やっている」単独では第三者目線の一般論とも区別できないため、一人称語が近傍にある場合のみ自己経験ブリッジとして扱う。
  // 所有格越しの第三者主語と、節中の別主語 (Xが/Xは) を挟む非所有格の第三者言及は除外する。
  /(?:自分|私|僕|わたし|ぼく)(?!の[^。、]{0,10}(?:が|は))(?:が|は|も)?[^。、がは]{0,20}(?:使って(?:い)?(?:る|た)|やって(?:い)?(?:る|た))/u,
  // 主語省略でも一人称の経験として読める、節冒頭限定の自己経験ブリッジ。
  // 節頭 (文頭または句読点直後) に限定して「友人も以前…」のような第三者主語つきの節中の以前と区別し、
  // 「以前は/昔は」のような主題を示す係助詞「は」は主語省略の一部として許容する。
  // さらに「以前友人が/以前同僚が」のような節頭直後の第三者主語 (Xが/Xは) を挟む形は、
  // その後で「が」「は」の出現を禁じることで除外する (真の主語省略のみを対象とする)。
  /(?<=^|[。、])(?:以前|昔)(?:は)?[^。、がは]{0,20}(?:経験(?:した|がある|を[^。、]{0,10}した)|(?:やって|して)(?:い)?た)/u,
  /(?<=^|[。、])今も[^。、]{0,20}ている身として/u,
  /我也|我自己|我之前|我一直/u,
]

// `generic_reply_farming` と同じ「汎用的な共感・評価」の語彙を soft signal としてのみ使う。
// このルールでは候補判定の hard gate にはしない。
const GENERIC_REACTION_PATTERNS = [
  /(?:わかり|分かり|素敵|すご|大変|つら|辛|嬉し|お疲れ|本当|ほんと|めっちゃ|ですよね|ですね|だね|ますね|良かった|よかった|大事|大切|かもしれません)/u,
  /(?:本当|ほんと)に(?:すご|素敵|大変|つら|辛|嬉し|良|愛おし|尊|心)/u,
  /(?:すご|素敵|大変|つら|辛|嬉し|愛おし|たまらな|心に響|胸が熱|温かい気持ち)/u,
  /(?:わか|分か)(?:る|ります|るよね|りますよね)/u,
  /(?:大事|大切)だと思(?:う|います)/u,
  /(?:ですよね|ますよね|ですね)(?:[。！!…]|$)/u,
  /(?:信頼されてる証拠|関係性が伝わ|人柄が出)/u,
]

const X_OWNED_HOST_SUFFIXES = ['x.com', 'twitter.com', 't.co', 'twimg.com']

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

function hasGenericReaction(text: string): boolean {
  return GENERIC_REACTION_PATTERNS.some((pattern) => pattern.test(text))
}

function accountAgeDays(accountCreatedAt: Date): number {
  return Math.max(1, (Date.now() - accountCreatedAt.getTime()) / 86_400_000)
}

function averageTweetsPerDay(tweetCount: number, ageDays: number): number {
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

function isXOwnedUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
    return X_OWNED_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    )
  } catch {
    return false
  }
}

function hasNonXExternalUrl(tweet: {
  expandedUrls?: string[]
  cardDestinationUrls?: string[]
}): boolean {
  const urls = [...(tweet.expandedUrls ?? []), ...(tweet.cardDestinationUrls ?? [])]
  return urls.some((url) => {
    try {
      const parsed = new URL(url)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !isXOwnedUrl(url)
    } catch {
      return false
    }
  })
}

export const contextualReplyMarketingRule: LabelRule = {
  key: 'contextual_reply_marketing',
  description:
    '大量投稿ボットではない低頻度アカウントが、異なる外部投稿者の投稿へ文脈に沿った長めの共感/称賛リプライを置きつつ、' +
    '「自分も」「〜として」「自分の立場では」等の自己ポジショニングを反復してプロフィール流入を狙う行動を検出する。' +
    'AI/LLM 利用そのものは推定しない',
  version: '0.3.0',
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
    const distinctParentAuthors = new Set(externalReplies.map((tweet) => tweet.parentTweetAuthorId))
      .size
    const distinctParentAuthorRatio =
      externalReplies.length > 0 ? distinctParentAuthors / externalReplies.length : 0
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
    const genericReactionRatio =
      normalizedExternalReplies.length > 0
        ? normalizedExternalReplies.filter((text) => hasGenericReaction(text)).length /
          normalizedExternalReplies.length
        : 0
    const originalTweets = sampled.filter((tweet) => !tweet.isReply && !tweet.isRetweet)
    const originalExternalUrlRatio =
      originalTweets.length > 0
        ? originalTweets.filter((tweet) => hasNonXExternalUrl(tweet)).length / originalTweets.length
        : 0
    const accountAge = accountAgeDays(bundle.account.accountCreatedAt)
    const tweetsPerDay = averageTweetsPerDay(bundle.account.tweetCount, accountAge)
    const recentTweetsPerDay = recentObservedTweetsPerDay(sampled)
    const isVerifiedBusiness =
      bundle.account.verifiedType === 'Business' ||
      bundle.account.professionalType === 'Business'

    const hasEnoughSample = sampled.length >= MIN_SAMPLE
    const evaluable = hasEnoughSample && parentAuthorCoverage >= PARENT_AUTHOR_COVERAGE_THRESHOLD
    const candidate =
      externalReplies.length >= MIN_EXTERNAL_REPLIES &&
      externalReplyRatio >= EXTERNAL_REPLY_RATIO_THRESHOLD &&
      distinctParentRatio >= DISTINCT_PARENT_RATIO_THRESHOLD &&
      distinctParentAuthors >= MIN_DISTINCT_PARENT_AUTHORS &&
      distinctParentAuthorRatio >= DISTINCT_PARENT_AUTHOR_RATIO_THRESHOLD &&
      tweetsPerDay <= LIFETIME_VELOCITY_MAX_PER_DAY &&
      averageReplyLength >= MIN_AVERAGE_REPLY_LENGTH &&
      questionRatio <= MAX_QUESTION_RATIO &&
      selfPositioningCount >= MIN_SELF_POSITIONING_COUNT &&
      selfPositioningRatio >= SELF_POSITIONING_RATIO_THRESHOLD &&
      !isVerifiedBusiness
    const value = evaluable && candidate

    const baseEvidenceScore = combineRequired([
      rampScore(externalReplies.length, MIN_EXTERNAL_REPLIES, MIN_EXTERNAL_REPLIES),
      rampScore(externalReplyRatio, EXTERNAL_REPLY_RATIO_THRESHOLD, 0.2),
      rampScore(distinctParentRatio, DISTINCT_PARENT_RATIO_THRESHOLD, 0.2),
      rampScore(distinctParentAuthors, MIN_DISTINCT_PARENT_AUTHORS, MIN_DISTINCT_PARENT_AUTHORS),
      rampScore(distinctParentAuthorRatio, DISTINCT_PARENT_AUTHOR_RATIO_THRESHOLD, 0.2),
      rampScore(
        tweetsPerDay,
        LIFETIME_VELOCITY_MAX_PER_DAY,
        LIFETIME_VELOCITY_MAX_PER_DAY,
        'lower-is-positive',
      ),
      rampScore(averageReplyLength, MIN_AVERAGE_REPLY_LENGTH, MIN_AVERAGE_REPLY_LENGTH),
      rampScore(questionRatio, MAX_QUESTION_RATIO, MAX_QUESTION_RATIO, 'lower-is-positive'),
      rampScore(selfPositioningCount, MIN_SELF_POSITIONING_COUNT, MIN_SELF_POSITIONING_COUNT),
      rampScore(selfPositioningRatio, SELF_POSITIONING_RATIO_THRESHOLD, 0.5),
      isVerifiedBusiness ? 0 : 1,
    ])
    const softSupportScore =
      (rampScore(genericReactionRatio, GENERIC_REACTION_RATIO_SOFT_THRESHOLD, 0.4) +
        rampScore(
          originalExternalUrlRatio,
          ORIGINAL_EXTERNAL_URL_RATIO_SOFT_THRESHOLD,
          ORIGINAL_EXTERNAL_URL_RATIO_SOFT_THRESHOLD,
        ) +
        rampScore(
          accountAge,
          NEW_ACCOUNT_AGE_DAYS_SOFT_THRESHOLD,
          NEW_ACCOUNT_AGE_DAYS_SOFT_THRESHOLD,
          'lower-is-positive',
        )) /
      3
    const evidenceScore = value
      ? Math.min(1, baseEvidenceScore + softSupportScore * SOFT_CONFIDENCE_MAX_BONUS)
      : baseEvidenceScore

    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      evaluable,
      reason:
        `tweetsPerDay=${tweetsPerDay.toFixed(1)}, recentTweetsPerDay=${recentTweetsPerDay.toFixed(1)}, ` +
        `parentAuthorCoverage=${parentAuthorCoverage.toFixed(2)}, externalReplies=${externalReplies.length}, ` +
        `externalReplyRatio=${externalReplyRatio.toFixed(2)}, distinctParentRatio=${distinctParentRatio.toFixed(2)}, ` +
        `distinctParentAuthors=${distinctParentAuthors}, distinctParentAuthorRatio=${distinctParentAuthorRatio.toFixed(2)}, ` +
        `avgReplyLength=${averageReplyLength.toFixed(1)}, questionRatio=${questionRatio.toFixed(2)}, ` +
        `selfPositioningCount=${selfPositioningCount}, selfPositioningRatio=${selfPositioningRatio.toFixed(2)}, ` +
        `genericReactionRatio=${genericReactionRatio.toFixed(2)}, originalExternalUrlRatio=${originalExternalUrlRatio.toFixed(2)}, ` +
        `accountAgeDays=${accountAge.toFixed(1)}, softSupportScore=${softSupportScore.toFixed(2)}, ` +
        `verifiedBusiness=${isVerifiedBusiness} (n=${sampled.length})`,
    }
  },
}
