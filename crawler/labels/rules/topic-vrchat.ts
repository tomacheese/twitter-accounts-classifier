import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 単語境界 (\b) はアンダースコアを単語構成文字として扱うため使わない。
// これだとハンドル名メンション (「_VRC」「VRC_」) を拾えなくなる。
// 「VRCID」のような連結表記も拾えるよう、ID が続く場合のみ例外的に許可する。
// 「ぶいちゃん」のような無関係な固有名詞との部分一致を避けるため、直後に「ん」が続く場合は除外する。
const VRCHAT_PATTERN = /VRChat|ぶいちゃ(?!ん)|(?<![A-Za-z0-9])VRC(?:(?![A-Za-z0-9])|(?=ID))/i

export const topicVrchatRule: LabelRule = {
  key: 'topic_vrchat',
  description: 'プロフィールまたは直近のツイートで VRChat を中心的な関心事として挙げている',
  version: '1.1.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const bioMatch = bio !== null && VRCHAT_PATTERN.test(bio)
    const tweetMatch = bundle.recentTweets
      .filter((tweet) => !tweet.isRetweet)
      .some((tweet) => VRCHAT_PATTERN.test(tweet.fullText))
    const keywordMatch = bioMatch || tweetMatch
    const followGraphMatch = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_vrchat)
    const value = keywordMatch || followGraphMatch
    return {
      value,
      confidence: keywordMatch ? 0.8 : followGraphMatch ? 0.5 : 0,
      reason: `bio/tweet vrchat-keyword match=${keywordMatch}, follow-graph match=${followGraphMatch}`,
    }
  },
}
