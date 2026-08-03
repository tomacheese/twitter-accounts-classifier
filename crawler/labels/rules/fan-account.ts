import type { LabelRule } from '../types'

/**
 * X の `parodyCommentaryFanLabel` フィールドを通じてファン関係を自己申告しているアカウントを検出する。
 * `'None'` はフィールドを取得済みでラベルなしと明示された状態を意味し、
 * 未取得を表す `null`/`undefined` とは区別されるが、
 * 本ルールではどちらも「未申告」として扱う。
 * `isBlueVerified` や組織 `verifiedType` の有無で絞り込まないのは意図的な設計で、
 * この申告は認証状態と無関係な API 直接の自己申告だから。
 */
export const fanAccountRule: LabelRule = {
  key: 'fan_account',
  description: 'ファンアカウントであることを自己申告している',
  version: '1.0.0',
  evaluate(bundle) {
    const { parodyCommentaryFanLabel } = bundle.account
    const value = parodyCommentaryFanLabel === 'Fan'

    return {
      value,
      confidence: 1,
      reason: `API reported parodyCommentaryFanLabel=${parodyCommentaryFanLabel ?? 'null'}`,
    }
  },
}
