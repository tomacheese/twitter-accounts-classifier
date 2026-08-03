import type { LabelRule } from '../types'

// NBA/MLB のような略語が無関係な語の内部に一致しないよう、
// 英単語は単語境界で判定している。
// 日本語は単語境界の概念が同様には成り立たないため部分一致のままとしている。
//
// スポーツ は直前の e (全角・半角、大小問わず) を除外している。
// eスポーツ は topic_gaming 側のシグナルとして扱っており、
// ここに含めると eスポーツ 関連のプレイヤーや会場アカウントを誤ってスポーツ関心ありとして検知してしまうため。
const SPORTS_PATTERN =
  /\b(baseball|soccer|basketball|NBA|MLB|NPB)\b|(?<![eEｅＥ])スポーツ|野球|サッカー|バスケ(ットボール)?|Jリーグ/i

export const topicSportsRule: LabelRule = {
  key: 'topic_sports',
  description: 'プロフィールでスポーツを中心的な関心事として挙げている',
  version: '1.1.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && SPORTS_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio sports-keyword match=${value}`,
    }
  },
}
