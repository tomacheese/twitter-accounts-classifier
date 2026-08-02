import type { LabelRule } from '../types'

// 英単語は無関係な語の内部に一致しないよう単語境界で判定し、日本語は本プロジェクトの
// topic_* ルール群の慣例に倣い部分一致としている。
//
// 旅 単体は人名や店舗名の一部としても一般的に使われる文字であるため対象語から除外し、
// 明確な複合語のみを用いている。
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
