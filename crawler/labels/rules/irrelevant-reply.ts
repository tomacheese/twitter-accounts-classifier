import { posteriorProbabilityAtLeast, toConfidence } from '../confidence'
import type { AccountFeatureBundle, LabelRule } from '../types'
import { isRecentTweetsEvaluable } from '../recent-tweets-evaluable'
import { averagePairwiseSimilarity, hasLinguisticContent } from '../text-similarity'

// テンプレート一致や広告キーワードを伴わない話題無関係リプライは、
// templated_reply_network や ad_reply_hijack など既存のリプライ濫用系ルールのいずれにも引っかからない。
// 一方、話題に沿った通常のリプライは相手ツイートの語句をほとんど引用せずに応答するのが通常であり、
// 単発の低類似度だけを根拠にすると通常の会話まで誤検知してしまう。
// そのため単発ではなく、
// このアカウントのリプライの多くが parent と無関係という統計的な偏りを要求することで、
// 通常の会話パターンとの区別を図る。
const MIN_SAMPLE = 5
const SIMILARITY_THRESHOLD = 0.03
const IRRELEVANT_RATIO_THRESHOLD = 0.6
// 短すぎるリプライ(相槌等)は元々 parent との字面の重なりが小さくなりやすく、
// 無関係リプライと区別できないため評価対象から除外する。
const MIN_REPLY_LENGTH = 10

interface EvaluableCandidate {
  fullText: string
  parentTweetFullText: string
}

type RecentTweet = AccountFeatureBundle['recentTweets'][number]

function isEvaluableCandidate(tweet: RecentTweet): tweet is RecentTweet & EvaluableCandidate {
  return (
    tweet.isReply &&
    !tweet.isRetweet &&
    typeof tweet.parentTweetFullText === 'string' &&
    tweet.fullText.length >= MIN_REPLY_LENGTH &&
    hasLinguisticContent(tweet.fullText) &&
    hasLinguisticContent(tweet.parentTweetFullText)
  )
}

export const irrelevantReplyRule: LabelRule = {
  key: 'irrelevant_reply',
  description:
    'テンプレート一致や広告キーワードを伴わない、話題的に無関係なリプライを繰り返し投稿している。' +
    'バズった投稿等に自己宣伝的な無関係リプライを差し込む挙動を、リプライ本文と parent ツイート本文の類似度から検出する',
  version: '1.0.0',
  evaluate(bundle) {
    if (!isRecentTweetsEvaluable(bundle)) {
      return {
        value: false,
        confidence: 0.5,
        reason: 'recentTweets not evaluable',
        evaluable: false,
      }
    }

    const candidates = bundle.recentTweets.filter((tweet) => isEvaluableCandidate(tweet))
    if (candidates.length < MIN_SAMPLE) {
      return {
        value: false,
        confidence: 0.5,
        reason: `insufficient reply-with-parent sample (n=${candidates.length})`,
        evaluable: false,
      }
    }

    const irrelevantCount = candidates.filter(
      (tweet) =>
        averagePairwiseSimilarity([tweet.fullText, tweet.parentTweetFullText]) <
        SIMILARITY_THRESHOLD,
    ).length
    const value = irrelevantCount / candidates.length >= IRRELEVANT_RATIO_THRESHOLD
    const evidenceScore = posteriorProbabilityAtLeast(
      irrelevantCount,
      candidates.length,
      IRRELEVANT_RATIO_THRESHOLD,
    )

    return {
      value,
      confidence: toConfidence(value, evidenceScore),
      reason: `irrelevantReplies=${irrelevantCount}/${candidates.length}`,
    }
  },
}
