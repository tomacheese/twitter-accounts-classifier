import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import { upsertAccount } from './account-repository'
import type { BlockListResult } from '../twitter/blocks'
import { computeBlockReconciliation, type BlockStatus } from './block-reconciliation'

const logger = Logger.configure('block-repository')

// `upsertFollowAuthors` と同じ理由で、1件の失敗が他アカウントの処理を止めないようアカウントごとに握りつぶす。
async function upsertBlockAuthors(prisma: PrismaClient, result: BlockListResult): Promise<void> {
  for (const author of result.authors) {
    try {
      await upsertAccount(prisma, author)
    } catch (error) {
      logger.error(
        `Failed to upsert account ${author.id} while syncing block edges`,
        error as Error,
      )
    }
  }
}

/**
 * `result.reachedEnd` が true かつ `result.ids` が空でないときのみ完全同期とみなし、
 * fetch できなかった既存 `blockedId` の行を `computeBlockReconciliation` で論理的に
 * missing/resolved へ進める (空レスポンスによる誤検知を防ぐガード)。物理削除はしない。
 * @param prisma - Prisma クライアント
 * @param blockerId - このブロック一覧の持ち主のアカウント
 * @param result - 取得したブロック一覧
 */
export async function syncBlocks(
  prisma: PrismaClient,
  blockerId: string,
  result: BlockListResult,
): Promise<void> {
  await upsertBlockAuthors(prisma, result)
  const now = new Date()
  const isCompleteSync = result.reachedEnd && result.ids.length > 0
  const fetchedIdSet = new Set(result.ids)

  await prisma.$transaction(
    async (tx) => {
      if (result.ids.length > 0) {
        await tx.block.createMany({
          data: result.ids.map((blockedId) => ({
            blockerId,
            blockedId,
            firstSeenAt: now,
            lastSeenAt: now,
          })),
          skipDuplicates: true,
        })
        await tx.block.updateMany({
          where: { blockerId, blockedId: { in: result.ids } },
          data: { lastSeenAt: now },
        })
      }

      if (!isCompleteSync) return

      const existingBlocks = await tx.block.findMany({
        where: { blockerId, blockedId: { notIn: result.ids } },
      })
      for (const block of existingBlocks) {
        const reconciliation = computeBlockReconciliation({
          existingStatus: block.status as BlockStatus,
          consecutiveMissingCount: block.consecutiveMissingCount,
          isPresent: fetchedIdSet.has(block.blockedId),
          isCompleteSync,
        })
        if (
          reconciliation.nextStatus === block.status &&
          reconciliation.consecutiveMissingCount === block.consecutiveMissingCount
        ) {
          continue
        }

        await tx.block.update({
          where: { id: block.id },
          data: {
            status: reconciliation.nextStatus,
            consecutiveMissingCount: reconciliation.consecutiveMissingCount,
            lastCheckedAt: now,
            missingSinceAt:
              reconciliation.nextStatus === 'missing' && block.status !== 'missing'
                ? now
                : block.missingSinceAt,
            resolvedAt: reconciliation.nextStatus === 'resolved' ? now : null,
          },
        })
        await tx.blockStateChange.create({
          data: {
            blockId: block.id,
            fromStatus: block.status,
            toStatus: reconciliation.nextStatus,
            changedAt: now,
          },
        })
      }
    },
    // `./labeling-follow-sample-repository` の同じコメントを参照。
    // ロック保持時間も同様に伸びるが、blocker 側の書き込み間隔で吸収できる範囲に収まる。
    { maxWait: 15_000, timeout: 15_000 },
  )
}
