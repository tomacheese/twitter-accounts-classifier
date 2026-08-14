import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 単語境界 (\b) はアンダースコアを単語構成文字として扱うため使わない。
// これだとハンドル名メンション (「_VRC」「VRC_」) を拾えなくなる。
// 「VRCID」のような連結表記も拾えるよう、ID が続く場合のみ例外的に許可する。
// 「ぶいちゃん」のような無関係な固有名詞との部分一致を避けるため、直後に「ん」が続く場合は除外する。
const VRCHAT_PATTERN = /VRChat|ぶいちゃ(?!ん)|(?<![A-Za-z0-9])VRC(?:(?![A-Za-z0-9])|(?=ID))/i
const KEYWORD_SCORE = 0.8

export const topicVrchatRule: LabelRule = {
  key: 'topic_vrchat',
  description: 'プロフィールまたは直近ツイートの直接証拠、またはフォロー関係から VRChat との強い関連が示される',
  version: '1.1.1',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const bioMatch = bio !== null && VRCHAT_PATTERN.test(bio)
    const ownTweets = bundle.recentTweets.filter((tweet) => !tweet.isRetweet)
    const tweetMatch = ownTweets.some((tweet) => VRCHAT_PATTERN.test(tweet.fullText))
    const keywordMatch = bioMatch || tweetMatch
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_vrchat)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    // tweetMatch はキーワードに一致した場合のみ true になるため、
    // 「本文を確認したが一致しなかった」陰性の判定材料を evaluable から漏らさないよう、
    // ツイートの有無そのもの (ownTweets.length > 0) で判定する。
    const evaluable = bio !== null || ownTweets.length > 0 || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio/tweet vrchat-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
