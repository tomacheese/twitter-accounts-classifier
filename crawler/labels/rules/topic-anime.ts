import type { LabelRule } from '../types'

// 英単語は無関係な語の内部に一致しないよう単語境界で判定し、日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
const ANIME_PATTERN = /アニメ|漫画|\b(anime|manga)\b/i

export const topicAnimeRule: LabelRule = {
  key: 'topic_anime',
  description: 'プロフィールでアニメ/漫画を中心的な関心事として挙げている',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && ANIME_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio anime-keyword match=${value}`,
    }
  },
}
