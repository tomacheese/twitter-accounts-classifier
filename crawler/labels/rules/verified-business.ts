import type { LabelRule } from '../types'

/**
 * X の組織認証（ゴールドバッジ）を持つアカウントを検出する。企業やブランドなど、
 * X の組織認証に課金している主体が対象。判定は `verifiedType === 'Business'` のみで行う。
 * `verified-blue-individual` と異なり、現在の `isBlueVerified` の値によらず成立する。
 * （`verifiedType: 'Business'` かつ `isBlueVerified: false` でも、
 * 組織バッジを保持する実アカウントがあるため。）
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
