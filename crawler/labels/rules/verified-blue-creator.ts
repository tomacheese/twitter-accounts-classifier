import type { LabelRule } from '../types'

/**
 * Detects an individual Blue-verified account that has also enabled X's opt-in
 * "professional account" feature as a Creator (`professional.professionalType ===
 * 'Creator'`). Scoped the same way as `verified-blue-individual` (Blue-verified, no
 * organization/government `verifiedType`) since this is a further subdivision of that
 * population, not an independent signal.
 */
export const verifiedBlueCreatorRule: LabelRule = {
  key: 'verified_blue_creator',
  description: '個人の有料 X Blue 認証バッジを持ち、プロフェッショナルアカウント種別が Creator である',
  version: '1.0.0',
  evaluate(bundle) {
    const { isBlueVerified, verifiedType, professionalType } = bundle.account
    const hasOrganizationType = verifiedType !== null && verifiedType !== 'None'
    const value = isBlueVerified && !hasOrganizationType && professionalType === 'Creator'

    return {
      value,
      confidence: 1,
      reason: `API reported isBlueVerified=${isBlueVerified}, verifiedType=${verifiedType ?? 'null'}, professionalType=${professionalType ?? 'null'}`,
    }
  },
}
