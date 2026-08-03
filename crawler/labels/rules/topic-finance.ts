import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// invest は investigative 等の無関係な語に含まれてしまうため単語境界で判定しつつ、
// investing のような正当な語は除外しないよう否定先読みを用いている。
// 株式 も同様に 株式会社 という法人格の表記を除外している。
// 除外しなければ業種を問わずあらゆる企業アカウントを金融関心ありと誤判定してしまうため。
const FINANCE_PATTERN =
  /\b(trading|invest(?!igat)|broker|finance|financial)|証券|株式(?!会社)|資産運用/i

export const topicFinanceRule: LabelRule = {
  key: 'topic_finance',
  description: 'プロフィールで金融/トレーディングを中心的な関心事として挙げている',
  version: '1.2.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && FINANCE_PATTERN.test(bio)
    const followGraphMatch = hasFollowGraphTopicSignal(
      bundle.followGraphLabelSignals?.topic_finance,
    )
    const value = keywordMatch || followGraphMatch
    return {
      value,
      confidence: keywordMatch ? 0.8 : followGraphMatch ? 0.5 : 0,
      reason: `bio finance-keyword match=${keywordMatch}, follow-graph match=${followGraphMatch}`,
    }
  },
}
