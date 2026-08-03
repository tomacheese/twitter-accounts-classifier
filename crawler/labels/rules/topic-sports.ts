import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// NBA/MLB のような略語が無関係な語の内部に一致しないよう、
// 英単語は単語境界で判定している。
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
//
// スポーツ は直前の e (全角・半角、大小問わず) を除外している。
// eスポーツ は topic_gaming 側のシグナルとして扱っており、
// 含めると eスポーツ 関連のプレイヤーや会場アカウントをスポーツ関心ありと誤検知してしまうため。
const SPORTS_PATTERN =
  /\b(baseball|soccer|basketball|NBA|MLB|NPB)\b|(?<![eEｅＥ])スポーツ|野球|サッカー|バスケ(ットボール)?|Jリーグ/i

export const topicSportsRule: LabelRule = {
  key: 'topic_sports',
  description: 'プロフィールでスポーツを中心的な関心事として挙げている',
  version: '1.2.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && SPORTS_PATTERN.test(bio)
    const followGraphMatch = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_sports)
    const value = keywordMatch || followGraphMatch
    return {
      value,
      confidence: keywordMatch ? 0.8 : followGraphMatch ? 0.5 : 0,
      reason: `bio sports-keyword match=${keywordMatch}, follow-graph match=${followGraphMatch}`,
    }
  },
}
