import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import { upsertAccount } from './account-repository'
import type { BlockListResult } from '../twitter/blocks'

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
 * `result.reachedEnd` が true かつ `result.ids` が空でないときのみ、現存しない `blockedId` の行を削除してブロック解除を検知する (空レスポンスによる全件削除事故を防ぐガード)。
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

  await prisma.$transaction(async (tx) => {
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

    // `follow-repository.ts` の `syncFollowing` と同じガードで、空レスポンスによる全件削除事故を防ぐ。
    if (result.reachedEnd && result.ids.length > 0) {
      await tx.block.deleteMany({
        where: { blockerId, blockedId: { notIn: result.ids } },
      })
    }
  })
}
