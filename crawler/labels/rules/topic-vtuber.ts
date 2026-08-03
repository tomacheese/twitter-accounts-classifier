import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// 英語の vtuber は無関係な複合語の内部に一致しないよう単語境界で判定している。
// にじさんじ/ホロライブのような主要事務所名は、
// 特定の VTuber 事務所への所属は、ファン層・活動者としての強いシグナルのため対象語に含める。
const VTUBER_PATTERN = /\bvtuber\b|にじさんじ|ホロライブ|hololive/i

export const topicVtuberRule: LabelRule = {
  key: 'topic_vtuber',
  description: 'プロフィールで VTuber (視聴/活動) を中心的な関心事として挙げている',
  version: '1.1.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && VTUBER_PATTERN.test(bio)
    const followGraphMatch = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_vtuber)
    const value = keywordMatch || followGraphMatch
    return {
      value,
      confidence: keywordMatch ? 0.8 : followGraphMatch ? 0.5 : 0,
      reason: `bio vtuber-keyword match=${keywordMatch}, follow-graph match=${followGraphMatch}`,
    }
  },
}
