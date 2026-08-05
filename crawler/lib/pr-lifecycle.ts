export type PrLifecycleStatus =
  | 'merged'
  | 'ready'
  | 'waiting_checks'
  | 'review_required'
  | 'mergeability_unknown'
  | 'failed_checks'
  | 'merge_blocked'
  | 'auto_merge_disabled'
  | 'closed'

export interface PrStatusCheckRollupEntry {
  name: string
  conclusion: string | null
  status: string
}

export interface PrSnapshot {
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'
  mergeStateStatus: string
  autoMergeRequest: { enabledAt: string } | null
  reviewDecision: string | null
  statusCheckRollup: PrStatusCheckRollupEntry[]
}

/**
 * ここで名前一致のみを見て正規表現等で緩めていないのは、
 * CI ワークフロー名の変更・分割を PR 分類ロジックが黙って見逃すのを避けるため。
 * 一致しない場合は waiting_checks 側に倒し、ready と誤判定しない。
 */
const REQUIRED_CHECK_NAMES = [
  'Node CI / Check finished Node CI',
  'Docker CI / Check finished Docker CI',
]

function hasAllRequiredChecksSucceeded(rollup: PrStatusCheckRollupEntry[]): boolean {
  return REQUIRED_CHECK_NAMES.every((name) =>
    rollup.some((entry) => entry.name === name && entry.conclusion === 'SUCCESS'),
  )
}

function hasAnyRequiredCheckFailed(rollup: PrStatusCheckRollupEntry[]): boolean {
  return REQUIRED_CHECK_NAMES.some((name) =>
    rollup.some(
      (entry) => entry.name === name && entry.conclusion !== null && entry.conclusion !== 'SUCCESS',
    ),
  )
}

/**
 * @param snapshot - `gh pr view --json` から得た PR の状態スナップショット
 * @returns PR のライフサイクル分類
 */
export function classifyPrStatus(snapshot: PrSnapshot): PrLifecycleStatus {
  if (snapshot.state === 'MERGED') return 'merged'
  if (snapshot.state === 'CLOSED') return 'closed'
  if (hasAnyRequiredCheckFailed(snapshot.statusCheckRollup)) return 'failed_checks'
  if (!hasAllRequiredChecksSucceeded(snapshot.statusCheckRollup)) return 'waiting_checks'
  if (
    snapshot.reviewDecision === 'REVIEW_REQUIRED' ||
    snapshot.reviewDecision === 'CHANGES_REQUESTED'
  ) {
    return 'review_required'
  }
  if (snapshot.mergeable === 'CONFLICTING') return 'merge_blocked'
  if (snapshot.mergeable === 'UNKNOWN') return 'mergeability_unknown'
  if (!snapshot.autoMergeRequest) return 'auto_merge_disabled'
  return 'ready'
}
