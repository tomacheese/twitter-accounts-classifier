import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 「推し」は現在ではアニメ/ゲームキャラクター、
// VTuber (topic_vtuber で対応済み)、スポーツ選手、俳優、動物、
// 地域など何にでも使われる汎用的な表現になっており、
// 単体ではアイドルファン特有のシグナルとして使えないため、
// 意図的に対象語から除外している。
// 英単語は無関係な語の内部に一致しないよう単語境界で判定している。
const IDOL_PATTERN = /アイドル|\bidol\b|k-?pop|ジャニーズ|ハロプロ|坂道/i

export const topicIdolRule: LabelRule = {
  key: 'topic_idol',
  description: 'プロフィールでアイドル/推し活を中心的な関心事として挙げている',
  version: '1.2.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && IDOL_PATTERN.test(bio)
    const followGraphMatch = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_idol)
    const value = keywordMatch || followGraphMatch
    return {
      value,
      confidence: keywordMatch ? 0.8 : followGraphMatch ? 0.5 : 0,
      reason: `bio idol-keyword match=${keywordMatch}, follow-graph match=${followGraphMatch}`,
    }
  },
}
