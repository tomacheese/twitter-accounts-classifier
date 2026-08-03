import type { LabelRule } from '../types'

/**
 * X の `parodyCommentaryFanLabel` フィールドを通じて実況/解説関係を自己申告している
 * アカウントを検出する。`'None'` はフィールドを取得済みでラベルなしと明示された状態を
 * 意味し、未取得を表す `null`/`undefined` とは区別されるが、本ルールではどちらも
 * 「未申告」として扱う。`isBlueVerified` や組織 `verifiedType` の有無で絞り込まないのは
 * 意図的な設計で、この申告は認証状態と無関係な API 直接の自己申告だから。
 */
export const commentaryAccountRule: LabelRule = {
  key: 'commentary_account',
  description: '実況/解説アカウントであることを自己申告している',
  version: '1.0.0',
  evaluate(bundle) {
    const { parodyCommentaryFanLabel } = bundle.account
    const value = parodyCommentaryFanLabel === 'Commentary'

    return {
      value,
      confidence: 1,
      reason: `API reported parodyCommentaryFanLabel=${parodyCommentaryFanLabel ?? 'null'}`,
    }
  },
}
