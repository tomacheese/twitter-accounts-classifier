import type { Prisma, PrismaClient } from '../generated/prisma'

/** Block 行の論理状態。 */
export type BlockStatus = 'active' | 'missing' | 'resolved'

/**
 * computeBlockReconciliation の入力。
 */
export interface ComputeBlockReconciliationInput {
  /** 現在の Block 状態。 */
  existingStatus: BlockStatus
  /** これまで連続で不在だった回数。 */
  consecutiveMissingCount: number
  /** 今回の fetch 結果に含まれていたか。 */
  isPresent: boolean
  /** 今回の fetch がページングを完走したか。 */
  isCompleteSync: boolean
  /** resolved を確定させるまでの連続不在回数。 */
  resolutionCount?: number
}

/**
 * computeBlockReconciliation の結果。
 */
export interface ComputeBlockReconciliationResult {
  /** 遷移後の Block 状態。 */
  nextStatus: BlockStatus
  /** 遷移後の連続不在回数。 */
  consecutiveMissingCount: number
}

/**
 * fetch 対象に存在すれば無条件で active へ戻す。
 * 存在しない場合は完全同期 (isCompleteSync) のときだけ不在を確定させる。
 * 不完全な取得で不在を確定すると、レート制限やページング中断を誤検知するため。
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

/**
 * reconcileBlockRelations の入力。
 */
export interface ReconcileBlockRelationsInput {
  /** 対象のブロック元 Account ID。 */
  blockerId: string
  /** 今回の fetch で観測されたブロック先 Account ID 一覧。 */
  fetchedBlockedIds: string[]
  /** 今回の fetch がページングを完走したか。 */
  isCompleteSync: boolean
  /** 判定の基準時刻。 */
  now: Date
  /** 状態変化の出所を示す ID。 */
  sourceId?: string
  /** resolved を確定させるまでの連続不在回数。 */
  resolutionCount?: number
}

/**
 * blockerId が持つ既存 Block 行すべてに `computeBlockReconciliation` を適用し、
 * 状態が変わった行だけ BlockStateChange を 1 件追加する。物理削除は一切行わない。
 * @param prisma - Prisma クライアント
 * @param input - 対象 blockerId と今回 fetch できた blockedId 一覧
 */
export async function reconcileBlockRelations(
  prisma: PrismaClient,
  input: ReconcileBlockRelationsInput,
): Promise<void> {
  const existingBlocks = await prisma.block.findMany({ where: { blockerId: input.blockerId } })
  const fetchedIdSet = new Set(input.fetchedBlockedIds)

  for (const block of existingBlocks) {
    const result = computeBlockReconciliation({
      existingStatus: block.status as BlockStatus,
      consecutiveMissingCount: block.consecutiveMissingCount,
      isPresent: fetchedIdSet.has(block.blockedId),
      isCompleteSync: input.isCompleteSync,
      resolutionCount: input.resolutionCount,
    })

    if (
      result.nextStatus === block.status &&
      result.consecutiveMissingCount === block.consecutiveMissingCount
    ) {
      continue
    }

    await prisma.$transaction([
      prisma.block.update({
        where: { id: block.id },
        data: {
          status: result.nextStatus,
          consecutiveMissingCount: result.consecutiveMissingCount,
          lastCheckedAt: input.now,
          missingSinceAt:
            result.nextStatus === 'missing' && block.status !== 'missing'
              ? input.now
              : block.missingSinceAt,
          resolvedAt: result.nextStatus === 'resolved' ? input.now : null,
        },
      }),
      prisma.blockStateChange.create({
        data: {
          blockId: block.id,
          fromStatus: block.status,
          toStatus: result.nextStatus,
          changedAt: input.now,
          sourceId: input.sourceId,
        } satisfies Prisma.BlockStateChangeCreateInput,
      }),
    ])
  }
}
