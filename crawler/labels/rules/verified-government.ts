import type { LabelRule } from '../types'

/**
 * 政府/国家関係アカウント（グレーバッジ）を検出する。政府機関、当局者、国際/国家組織などが対象。
 * 判定は `verifiedType === 'Government'` のみで行う。
 * `verified-business` と同様、現在の `isBlueVerified` の値によらず成立する。
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
