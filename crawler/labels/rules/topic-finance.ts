import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// invest は investigative 等の無関係な語に含まれてしまうため単語境界で判定しつつ、
// investing のような正当な語は除外しないよう否定先読みを用いている。
// 除外語幹は英語の investigat- ではなく investig- とすることで、
// ポルトガル語/スペイン語の investigado(s) のような活用形も併せて除外している。
// 株式 も同様に 株式会社 という法人格の表記を除外している。
// 除外しなければ業種を問わずあらゆる企業アカウントを金融関心ありと誤判定してしまうため。
const FINANCE_PATTERN =
  /\b(trading|invest(?!ig)|broker|finance|financial)|証券|株式(?!会社)|資産運用/i

const KEYWORD_SCORE = 0.8

export const topicFinanceRule: LabelRule = {
  key: 'topic_finance',
  description: 'プロフィールで金融/トレーディングを中心的な関心事として挙げている',
  version: '1.3.1',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && FINANCE_PATTERN.test(bio)
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_finance)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio finance-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
