import { hasFollowGraphTopicSignal } from '../follow-graph-topic-signal'
import type { LabelRule } from '../types'

// Bare "beauty" is deliberately excluded: it hits generic idioms and business taglines
// unrelated to cosmetics ("the beauty of the open road", "timeless beauty" in a jewelry bio),
// so only the more specific compounds are matched. The negative lookbehind on メイク keeps
// ヘアメイク matching while excluding リメイク (remake), a common false-positive substring.
const BEAUTY_PATTERN = /コスメ|美容|(?<!リ)メイク|スキンケア|\b(cosmetics?|skincare|makeup)\b/i

export const topicBeautyRule: LabelRule = {
  key: 'topic_beauty',
  description: 'プロフィールで美容・コスメ・スキンケアを中心的な関心事として挙げている',
  version: '1.0.0',
  usesFollowGraphSignal: true,
  evaluate(bundle) {
    const { bio } = bundle.account
    const keywordMatch = bio !== null && BEAUTY_PATTERN.test(bio)
    const followGraphMatch = hasFollowGraphTopicSignal(bundle.followGraphLabelSignals?.topic_beauty)
    const value = keywordMatch || followGraphMatch
    return {
      value,
      confidence: keywordMatch ? 0.8 : followGraphMatch ? 0.5 : 0,
      reason: `bio beauty-keyword match=${keywordMatch}, follow-graph match=${followGraphMatch}`,
    }
  },
}
