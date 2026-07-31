import type { LabelRule } from '../types'

/**
 * Detects an individual, paid X Blue subscriber - the blue checkmark granted by
 * subscription, with no organization/government affiliation. `verifiedType` is `null`
 * (never crawled) or the literal string `'None'` (API reported no organization type) for
 * this case; either form means "no organization badge", distinguishing it from
 * `verified-business`/`verified-government`.
 */
export const verifiedBlueIndividualRule: LabelRule = {
  key: 'verified_blue_individual',
  description: '個人の有料 X Blue 認証バッジ（組織/政府認証は含まない）',
  version: '1.0.0',
  evaluate(bundle) {
    const { isBlueVerified, verifiedType } = bundle.account
    const hasOrganizationType = verifiedType !== null && verifiedType !== 'None'
    const value = isBlueVerified && !hasOrganizationType

    return {
      value,
      confidence: 1,
      reason: `API reported isBlueVerified=${isBlueVerified}, verifiedType=${verifiedType ?? 'null'}`,
    }
  },
}
