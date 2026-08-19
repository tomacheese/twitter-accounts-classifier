import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 英単語は無関係な語の内部に一致しないよう単語境界で判定し、
// 日本語は本プロジェクトの topic_* ルール群の慣例に倣い部分一致としている。
//
// 旅 単体は人名や店舗名の一部としても一般的に使われる文字であるため対象語から除外し、
// 明確な複合語のみを用いている。
//
// 「観光大使」「観光 PR 大使」のような肩書きは意図的にキーワード化していない。
// このルールの意図は本人の旅行への関心の自己申告を検出することであり、
// 大使という職務上の役割の言及はそれ自体が個人の関心を表明したものではないため。
const TRAVEL_PATTERN =
  /旅行|旅好き|一人旅|旅が好き|温泉巡り|\b(travel|travels|traveling|travelling|traveler|traveller|backpacker)\b/i

const KEYWORD_SCORE = 0.8

export const topicTravelRule: LabelRule = {
  key: 'topic_travel',
  description: 'プロフィールの直接証拠、またはフォロー関係から旅行との強い関連が示される',
  version: '1.1.1',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && TRAVEL_PATTERN.test(bio)
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_travel)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio travel-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
