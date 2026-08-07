import type { Prisma, PrismaClient } from '../generated/prisma'

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
 * fetch 対象に存在すれば無条件で active へ戻す。存在しない場合は、完全同期
 * (isCompleteSync) のときだけ不在を確定させ、不完全な取得では絶対に absence を
 * 確定しない (レート制限やページング途中断による誤検知を防ぐ)。
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

export interface ReconcileBlockRelationsInput {
  blockerId: string
  fetchedBlockedIds: string[]
  isCompleteSync: boolean
  now: Date
  sourceId?: string
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
