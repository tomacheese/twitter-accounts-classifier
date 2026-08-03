import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 英単語は無関係な語の内部に一致しないよう単語境界で判定している。
// 日本語は単語境界の概念が成り立たないため部分一致のままとしている。
const FOOD_PATTERN = /\b(cooking|foodie|chef)\b|グルメ|料理|食べ歩き|ラーメン|レシピ/i

export const topicFoodRule: LabelRule = {
  key: 'topic_food',
  description: 'プロフィールでグルメ/料理を中心的な関心事として挙げている',
  version: '1.1.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && FOOD_PATTERN.test(bio)
    const followGraphMatch = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_food)
    const value = keywordMatch || followGraphMatch
    return {
      value,
      confidence: keywordMatch ? 0.8 : followGraphMatch ? 0.5 : 0,
      reason: `bio food-keyword match=${keywordMatch}, follow-graph match=${followGraphMatch}`,
    }
  },
}
