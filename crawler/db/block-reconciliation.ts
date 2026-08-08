export type BlockStatus = 'active' | 'missing' | 'resolved'

export interface ComputeBlockReconciliationInput {
  existingStatus: BlockStatus
  consecutiveMissingCount: number
  isPresent: boolean
  isCompleteSync: boolean
  resolutionCount?: number
}

export interface ComputeBlockReconciliationResult {
  nextStatus: BlockStatus
  consecutiveMissingCount: number
}

/**
 * analyzer/blocks/reconcile-block-relations.ts の computeBlockReconciliation と
 * 同じ契約を持つ、crawler 側 Prisma Client 向けの実装。ワークスペースが分かれ
 * Prisma Client の型が別物になるため、ロジックを共有 package 化せずそれぞれで持つ
 * (analyzer 側の変更を crawler 側でも変える必要がある点は CI の両テストで検知する)。
 * @param input - 現在の Block 状態と今回の観測結果
 * @returns 次の状態と連続 missing 回数
 */
export function computeBlockReconciliation(
  input: ComputeBlockReconciliationInput,
): ComputeBlockReconciliationResult {
  if (input.isPresent) {
    return { nextStatus: 'active', consecutiveMissingCount: 0 }
  }
  if (!input.isCompleteSync) {
    return {
      nextStatus: input.existingStatus,
      consecutiveMissingCount: input.consecutiveMissingCount,
    }
  }

  const resolutionCount = input.resolutionCount ?? 3
  const nextConsecutiveMissingCount = input.consecutiveMissingCount + 1
  if (nextConsecutiveMissingCount >= resolutionCount) {
    return { nextStatus: 'resolved', consecutiveMissingCount: nextConsecutiveMissingCount }
  }
  return { nextStatus: 'missing', consecutiveMissingCount: nextConsecutiveMissingCount }
}
