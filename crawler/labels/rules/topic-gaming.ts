import type { LabelRule } from '../types'

// 英単語は無関係な語の内部に一致しないよう単語境界で判定している。
// 日本語は単語境界の概念が成り立たないため部分一致のままとしている。
const GAMING_PATTERN = /ゲーム|ゲーマー|ソシャゲ|eスポーツ|\b(gamer|gaming|esports)\b/i

export const topicGamingRule: LabelRule = {
  key: 'topic_gaming',
  description: 'プロフィールでゲームを中心的な関心事として挙げている',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && GAMING_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio gaming-keyword match=${value}`,
    }
  },
}
