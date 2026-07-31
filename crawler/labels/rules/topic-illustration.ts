import type { LabelRule } from '../types'

// This targets the "I draw/post my own art" declaration, a different axis from topic_anime,
// which covers consuming anime/manga rather than producing art. English terms are
// word-boundary-matched to avoid matching inside unrelated compound words; Japanese terms are
// left as substring matches per this project's existing topic_* convention.
const ILLUSTRATION_PATTERN = /イラスト|絵師|絵描き|\billustrator\b|pixiv/i

export const topicIllustrationRule: LabelRule = {
  key: 'topic_illustration',
  description: 'プロフィールでイラスト制作/投稿を中心的な関心事として挙げている',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && ILLUSTRATION_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio illustration-keyword match=${value}`,
    }
  },
}
