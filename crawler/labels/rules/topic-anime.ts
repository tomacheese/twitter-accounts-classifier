import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 英単語は無関係な語の内部に一致しないよう単語境界で判定している。
// 日本語は単語境界の概念が成り立たないため部分一致のままとしている。
const ANIME_PATTERN = /アニメ|漫画|\b(anime|manga)\b/i
const KEYWORD_SCORE = 0.8

export const topicAnimeRule: LabelRule = {
  key: 'topic_anime',
  description:
    'プロフィールに「アニメ」「漫画」等の直接証拠があるか、フォロー関係からアニメ/漫画との強い関連が示される。作品名だけの列挙は直接証拠に含めない',
  version: '1.2.0',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && ANIME_PATTERN.test(bio)
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_anime)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio anime-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
