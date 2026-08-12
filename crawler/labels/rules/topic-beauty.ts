import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 素の "beauty" は美容と無関係な慣用句や宣伝文句 (旅先の景観、ジュエリーの謳い文句など) にも
// 頻出するため対象外とし、より限定的な複合語のみに一致させている。
// メイクへの否定後読みは、ヘアメイクへの一致を保ったまま誤検知の多いリメイクの部分一致を除外するため。
const BEAUTY_PATTERN = /コスメ|美容|(?<!リ)メイク|スキンケア|\b(cosmetics?|skincare|makeup)\b/i

const KEYWORD_SCORE = 0.8

export const topicBeautyRule: LabelRule = {
  key: 'topic_beauty',
  description: 'プロフィールで美容・コスメ・スキンケアを中心的な関心事として挙げている',
  version: '1.0.1',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && BEAUTY_PATTERN.test(bio)
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_beauty)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio beauty-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
