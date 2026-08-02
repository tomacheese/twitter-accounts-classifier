import type { LabelRule } from '../types'

// invest は investigative 等の無関係な語に含まれてしまうため単語境界で判定しつつ、
// investing のような正当な語は除外しないよう否定先読みを用いている。
// 株式 も同様に 株式会社 という法人格の表記を除外している。除外しなければ業種を問わず
// あらゆる企業アカウントを金融関心ありと誤判定してしまうため。
const FINANCE_PATTERN =
  /\b(trading|invest(?!igat)|broker|finance|financial)|証券|株式(?!会社)|資産運用/i

export const topicFinanceRule: LabelRule = {
  key: 'topic_finance',
  description: 'プロフィールで金融/トレーディングを中心的な関心事として挙げている',
  version: '1.1.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && FINANCE_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio finance-keyword match=${value}`,
    }
  },
}
