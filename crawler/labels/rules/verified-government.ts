import type { LabelRule } from '../types'

/**
 * Detects a government/state-affiliated account (gray checkmark) - government agencies,
 * officials, and multilateral/state-affiliated organizations. Determined solely by
 * `verifiedType === 'Government'`; same as `verified-business`, this holds regardless of
 * the current `isBlueVerified` value.
 */
export const verifiedGovernmentRule: LabelRule = {
  key: 'verified_government',
  description: 'X の政府/国家機関認証（グレーバッジ）を保持しているアカウント',
  version: '1.0.0',
  evaluate(bundle) {
    const { verifiedType } = bundle.account
    const value = verifiedType === 'Government'

    return {
      value,
      confidence: 1,
      reason: `API reported verifiedType=${verifiedType ?? 'null'}`,
    }
  },
}
