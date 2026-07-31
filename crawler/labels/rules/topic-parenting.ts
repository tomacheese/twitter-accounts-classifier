import type { LabelRule } from '../types'

// English terms are word-boundary-matched to avoid matching inside unrelated words.
// Japanese terms are left as substring matches since word boundaries don't apply the
// same way to Japanese script.
const PARENTING_PATTERN = /\bparenting\b|育児|子育て|ワーママ|ワンオペ育児/i

export const topicParentingRule: LabelRule = {
  key: 'topic_parenting',
  description: 'プロフィールで育児/子育てを中心的な関心事として挙げている',
  version: '1.0.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && PARENTING_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio parenting-keyword match=${value}`,
    }
  },
}
