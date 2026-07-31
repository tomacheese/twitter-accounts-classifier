import type { LabelRule } from '../types'

// English terms are word-boundary-matched to avoid matching inside unrelated words.
// Japanese terms are left as substring matches since word boundaries don't apply the
// same way to Japanese script.
const FOOD_PATTERN = /\b(cooking|foodie|chef)\b|グルメ|料理|食べ歩き|ラーメン|レシピ/i

export const topicFoodRule: LabelRule = {
  key: 'topic_food',
  description: 'プロフィールでグルメ/料理を中心的な関心事として挙げている',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && FOOD_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio food-keyword match=${value}`,
    }
  },
}
