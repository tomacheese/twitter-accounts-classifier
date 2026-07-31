import type { LabelRule } from '../types'

/**
 * Detects a Verified Organization (gold checkmark) account - companies, brands, and
 * other businesses that pay for X's organization verification. Determined solely by
 * `verifiedType === 'Business'`; unlike `verified-blue-individual`, this holds regardless
 * of the current `isBlueVerified` value (real accounts observed with
 * `verifiedType: 'Business'` but `isBlueVerified: false` still carry the org badge).
 */
export const verifiedBusinessRule: LabelRule = {
  key: 'verified_business',
  description: 'X の組織認証（ゴールドバッジ）を保持している企業/ブランドアカウント',
  version: '1.0.0',
  evaluate(bundle) {
    const { verifiedType } = bundle.account
    const value = verifiedType === 'Business'

    return {
      value,
      confidence: 1,
      reason: `API reported verifiedType=${verifiedType ?? 'null'}`,
    }
  },
}
