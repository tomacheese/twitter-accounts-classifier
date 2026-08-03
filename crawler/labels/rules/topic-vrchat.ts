import type { LabelRule } from '../types'

// 単語境界 (\b) はアンダースコアを単語構成文字として扱うため使わない。
// これだとハンドル名メンション (「_VRC」「VRC_」) を拾えなくなる。
// 「VRCID」のような連結表記も拾えるよう、ID が続く場合のみ例外的に許可する。
const VRCHAT_PATTERN = /VRChat|ぶいちゃ|(?<![A-Za-z0-9])VRC(?:(?![A-Za-z0-9])|(?=ID))/i

export const topicVrchatRule: LabelRule = {
  key: 'topic_vrchat',
  description: 'プロフィールまたは直近のツイートで VRChat を中心的な関心事として挙げている',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const bioMatch = bio !== null && VRCHAT_PATTERN.test(bio)
    const tweetMatch = bundle.recentTweets.some((tweet) => VRCHAT_PATTERN.test(tweet.fullText))
    const value = bioMatch || tweetMatch
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio/tweet vrchat-keyword match=${value}`,
    }
  },
}
