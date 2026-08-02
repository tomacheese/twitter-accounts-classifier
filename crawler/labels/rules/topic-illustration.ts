import type { LabelRule } from '../types'

// topic_anime はアニメ・漫画を鑑賞する関心を対象としているのに対し、本ルールは自ら絵を描いて
// 発信している申告を対象とする、別軸のシグナルとして扱っている。
// 英単語は無関係な複合語の内部に一致しないよう単語境界で判定し、日本語は本プロジェクトの
// topic_* ルール群の慣例に倣い部分一致としている。
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
