import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 英単語は他の topic_* ルールとの表記統一のため単語境界で判定しており、
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
const MOVIE_PATTERN =
  /\b(movie|movies|film|cinema|moviegoer|cinephile)\b|映画|ドラマ|洋画|邦画|映画館|映画鑑賞/i

const KEYWORD_SCORE = 0.8

export const topicMovieRule: LabelRule = {
  key: 'topic_movie',
  description: 'プロフィールの直接証拠、またはフォロー関係から映画・ドラマとの強い関連が示される',
  version: '1.1.1',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && MOVIE_PATTERN.test(bio)
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_movie)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio movie-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
