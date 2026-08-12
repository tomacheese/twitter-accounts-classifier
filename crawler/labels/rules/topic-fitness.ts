import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 「筋肉痛」のような無関係な複合語まで拾わないよう、
// 単独の「筋肉」ではなく訓練・活動としての愛好を明示する複合語のみを対象とする。
const FITNESS_PATTERN =
  /筋トレ|フィットネス|ボディメイク|ジム通い|パーソナルトレーニング|自重トレ|\b(?:fitness|workout|gym\s*rat)\b/i

const KEYWORD_SCORE = 0.8

export const topicFitnessRule: LabelRule = {
  key: 'topic_fitness',
  description: 'プロフィールで筋トレ・ジム通いなどのフィットネスを中心的な関心事として挙げている',
  version: '1.0.1',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && FITNESS_PATTERN.test(bio)
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_fitness)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio fitness-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
