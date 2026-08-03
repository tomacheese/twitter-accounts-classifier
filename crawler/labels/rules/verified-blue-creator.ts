import type { LabelRule } from '../types'

/**
 * 個人の Blue 認証を持ち、かつ X のオプトイン機能「プロフェッショナルアカウント」を
 * Creator 種別で有効化している（`professional.professionalType === 'Creator'`）
 * アカウントを検出する。`verified-blue-individual` と同じ範囲
 * （Blue 認証あり、組織/政府の `verifiedType` なし）に限定するのは、これが独立した
 * 兆候ではなく、その母集団をさらに細分するものだから。
 */
export const verifiedBlueCreatorRule: LabelRule = {
  key: 'verified_blue_creator',
  description:
    '個人の有料 X Blue 認証バッジを持ち、プロフェッショナルアカウント種別が Creator である',
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
