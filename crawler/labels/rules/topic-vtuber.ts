import type { LabelRule } from '../types'

// English "vtuber" is word-boundary-matched to avoid matching inside unrelated compound
// words. The major-agency names (にじさんじ/ホロライブ) are included because affiliation with
// a specific VTuber agency is itself a strong VTuber-fandom/activity signal in this
// project's crawled Japanese Twitter population.
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
