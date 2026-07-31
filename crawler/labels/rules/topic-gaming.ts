import type { LabelRule } from '../types'

// English terms are word-boundary-matched to avoid matching inside unrelated words.
// Japanese terms are left as substring matches since word boundaries don't apply the
// same way to Japanese script.
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
