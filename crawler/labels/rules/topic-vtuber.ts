import { combineAlternatives, toConfidence } from '../confidence'
import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 英語の vtuber は無関係な複合語の内部に一致しないよう単語境界で判定している。
// にじさんじ/ホロライブのような主要事務所名は、
// 特定の VTuber 事務所への所属は、ファン層・活動者としての強いシグナルのため対象語に含める。
const VTUBER_PATTERN = /\bvtuber\b|にじさんじ|ホロライブ|hololive/i

const KEYWORD_SCORE = 0.8

export const topicVtuberRule: LabelRule = {
  key: 'topic_vtuber',
  description: 'プロフィールの直接証拠、またはフォロー関係から VTuber との強い関連が示される',
  version: '1.1.1',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && VTUBER_PATTERN.test(bio)
    const followGraph = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_vtuber)
    const value = keywordMatch || followGraph.matched
    const evidenceScore = combineAlternatives([
      keywordMatch ? KEYWORD_SCORE : 0,
      followGraph.evidenceScore,
    ])
    const evaluable = bio !== null || followGraph.evaluable
    return {
      value,
      confidence: toConfidence(value, evidenceScore, evaluable),
      reason: `bio vtuber-keyword match=${keywordMatch}, follow-graph match=${followGraph.matched}`,
      evaluable,
    }
  },
}
