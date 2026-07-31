import type { LabelRule } from '../types'

// English terms are word-boundary-matched to avoid matching inside unrelated words
// (e.g. "band" inside "husband"/"abandon"). Japanese terms are left as substring matches
// since word boundaries don't apply the same way to Japanese script.
const MUSIC_PATTERN =
  /\b(music|singer|musician|band|guitarist|vocalist|DJ)\b|音楽|バンド|作曲|シンガー|ミュージシャン/i

export const topicMusicRule: LabelRule = {
  key: 'topic_music',
  description: 'プロフィールで音楽を中心的な関心事として挙げている',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && MUSIC_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio music-keyword match=${value}`,
    }
  },
}
