import type { LabelRule } from '../types'

// 英語の vtuber は無関係な複合語の内部に一致しないよう単語境界で判定している。
// にじさんじ/ホロライブのような主要事務所名は、
// 特定の VTuber 事務所への所属自体が VTuber ファン層・活動者としての強いシグナルになるため対象語に含めている。
const VTUBER_PATTERN = /\bvtuber\b|にじさんじ|ホロライブ|hololive/i

export const topicVtuberRule: LabelRule = {
  key: 'topic_vtuber',
  description: 'プロフィールで VTuber (視聴/活動) を中心的な関心事として挙げている',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && VTUBER_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio vtuber-keyword match=${value}`,
    }
  },
}
