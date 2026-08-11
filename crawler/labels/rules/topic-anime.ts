import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 英単語は無関係な語の内部に一致しないよう単語境界で判定している。
// 日本語は単語境界の概念が成り立たないため部分一致のままとしている。
const ANIME_PATTERN = /アニメ|漫画|\b(anime|manga)\b/i

export const topicAnimeRule: LabelRule = {
  key: 'topic_anime',
  description: 'プロフィールでアニメ/漫画を中心的な関心事として挙げている',
  version: '1.1.0',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && ANIME_PATTERN.test(bio)
    const followGraphMatch = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_anime)
    const value = keywordMatch || followGraphMatch
    return {
      value,
      confidence: keywordMatch ? 0.8 : followGraphMatch ? 0.5 : 0,
      reason: `bio anime-keyword match=${keywordMatch}, follow-graph match=${followGraphMatch}`,
    }
  },
}
