import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// band は husband/abandon 等の無関係な語に含まれてしまうため、
// 英単語は単語境界で判定している。
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
const MUSIC_PATTERN =
  /\b(music|singer|musician|band|guitarist|vocalist|DJ)\b|音楽|バンド|作曲|シンガー|ミュージシャン/i

export const topicMusicRule: LabelRule = {
  key: 'topic_music',
  description: 'プロフィールで音楽を中心的な関心事として挙げている',
  version: '1.1.0',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && MUSIC_PATTERN.test(bio)
    const followGraphMatch = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_music)
    const value = keywordMatch || followGraphMatch
    return {
      value,
      confidence: keywordMatch ? 0.8 : followGraphMatch ? 0.5 : 0,
      reason: `bio music-keyword match=${keywordMatch}, follow-graph match=${followGraphMatch}`,
    }
  },
}
