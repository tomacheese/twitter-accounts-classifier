import type { LabelRule } from '../types'

// band は husband/abandon 等の無関係な語に含まれてしまうため、
// 英単語は単語境界で判定している。
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
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
