import type { LabelRule } from '../types'

/**
 * 課金による個人の X Blue 認証（青バッジ）を検出する。組織/政府認証を伴わない場合が
 * 対象。この場合の `verifiedType` は `null`（未取得）または文字列 `'None'`（API が
 * 組織種別なしと報告）のいずれかを取り得るが、どちらも「組織バッジなし」を意味する点は
 * 同じであり、`verified-business`/`verified-government` と区別するために両方を許容する。
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
