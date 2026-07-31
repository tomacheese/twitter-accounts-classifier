import type { LabelRule } from '../types'

// English terms are word-boundary-matched to avoid matching inside unrelated words
// (e.g. "invest" inside "investigative"/"investigator"); "invest" additionally excludes
// the "-igat-" continuation via negative lookahead so it still matches legitimate
// substrings like "investing"/"investment"/"investor". Japanese terms are left as
// substring matches since word boundaries don't apply the same way to Japanese script,
// except "株式" which excludes the "会社" continuation via negative lookahead - "株式会社"
// is the ubiquitous Japanese corporate suffix ("Co., Ltd."/"Inc.") that nearly every
// company bio carries regardless of industry, so without this exclusion it falsely
// flags any company account as finance-focused.
const FINANCE_PATTERN =
  /\b(trading|invest(?!igat)|broker|finance|financial)|証券|株式(?!会社)|資産運用/i

export const topicFinanceRule: LabelRule = {
  key: 'topic_finance',
  description: 'プロフィールで金融/トレーディングを中心的な関心事として挙げている',
  version: '1.1.0',
  evaluate(bundle) {
    const { bio } = bundle.account
    const value = bio !== null && FINANCE_PATTERN.test(bio)
    return {
      value,
      confidence: value ? 0.8 : 0,
      reason: `bio finance-keyword match=${value}`,
    }
  },
}
