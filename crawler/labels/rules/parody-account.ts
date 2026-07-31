import type { LabelRule } from '../types'

/**
 * Detects an account that has self-declared a parody relationship via X's
 * `parodyCommentaryFanLabel` field. `'None'` means the field was fetched and the account
 * explicitly has no such label, distinct from `null`/`undefined` (never fetched) - both
 * are treated as "not declared" here. This is deliberately not gated on `isBlueVerified` or
 * on the absence of an organization `verifiedType`: the declaration is a direct API
 * self-report, independent of verification status.
 */
export const parodyAccountRule: LabelRule = {
  key: 'parody_account',
  description: 'パロディアカウントであることを自己申告している',
  version: '1.0.0',
  evaluate(bundle) {
    const { parodyCommentaryFanLabel } = bundle.account
    const value = parodyCommentaryFanLabel === 'Parody'

    return {
      value,
      confidence: 1,
      reason: `API reported parodyCommentaryFanLabel=${parodyCommentaryFanLabel ?? 'null'}`,
    }
  },
}
