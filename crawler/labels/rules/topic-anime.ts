import type { LabelRule } from '../types'

// English terms are word-boundary-matched to avoid matching inside unrelated words.
// Japanese terms are left as substring matches since word boundaries don't apply the
// same way to Japanese script.
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
