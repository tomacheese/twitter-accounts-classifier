import type { LabelRule } from '../types'

/**
 * 個人の Blue 認証を持ち、
 * かつプロフェッショナルアカウントを Business 種別で有効化しているアカウントを検出する (`professional.professionalType === 'Business'`)。
 * X の有料組織認証（ゴールドバッジ）である `verified-business` とは別概念の、
 * セルフサービス型の小規模事業者向け機能。
 * `verified-blue-individual` と同じ範囲（Blue 認証あり、組織/政府の `verifiedType` なし）に限定するのは、
 * これが独立した兆候ではなく、その母集団をさらに細分するものだから。
 */
export const verifiedBlueProfessionalBusinessRule: LabelRule = {
  key: 'verified_blue_professional_business',
  description:
    '個人の有料 X Blue 認証バッジを持ち、プロフェッショナルアカウント種別が Business である（組織認証とは別概念）',
  version: '1.0.0',
  evaluate(bundle) {
    const { isBlueVerified, verifiedType, professionalType } = bundle.account
    const hasOrganizationType = verifiedType !== null && verifiedType !== 'None'
    const value = isBlueVerified && !hasOrganizationType && professionalType === 'Business'

    return {
      value,
      confidence: 1,
      reason: `API reported isBlueVerified=${isBlueVerified}, verifiedType=${verifiedType ?? 'null'}, professionalType=${professionalType ?? 'null'}`,
    }
  },
}
