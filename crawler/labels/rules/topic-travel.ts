import type { LabelRule } from '../types'

// English terms are word-boundary-matched to avoid matching inside unrelated words;
// Japanese terms are left as substring matches per this project's existing topic_*
// convention.
//
// 旅 on its own is deliberately not matched: it is a common given-name and shop-name
// character (旅人, 旅館 as an employer, etc.), so only the explicit compounds are used.
const TRAVEL_PATTERN =
  /旅行|旅好き|一人旅|旅が好き|温泉巡り|\b(travel|travels|traveling|travelling|traveler|traveller|backpacker)\b/i

export const topicTravelRule: LabelRule = {
  key: 'topic_travel',
  description: 'プロフィールで旅行を中心的な関心事として挙げている',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && TRAVEL_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio travel-keyword match=${value}`,
    }
  },
}
