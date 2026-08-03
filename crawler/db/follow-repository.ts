import { Logger } from '@book000/node-utils'
import type { PrismaClient } from '../generated/prisma'
import { upsertAccount } from './account-repository'
import type { FollowListResult } from '../twitter/follows'

const logger = Logger.configure('follow-repository')

// `./tweet-repository` の `upsertTweets` と同様、
// アカウントごとに個別に upsert する:1 件の不正なプロフィールで、
// 残りのバッチや後続の edge 同期まで止めてはならないため。
async function upsertFollowAuthors(prisma: PrismaClient, result: FollowListResult): Promise<void> {
  for (const author of result.authors) {
    try {
      await upsertAccount(prisma, author)
    } catch (error) {
      logger.error(
        `Failed to upsert account ${author.id} while syncing follow edges`,
        error as Error,
      )
    }
  }
}

/**
 * edge の upsert と削除を 1 つのトランザクションにまとめる: 同期途中の失敗で、
 * 新旧の edge が中途半端に混在した状態を残さないため。
 * @param prisma - Prisma クライアント
 * @param followerId - フォロー中リストの対象アカウント
 * @param result - 取得したフォロー中リスト
 */
export async function syncFollowing(
  prisma: PrismaClient,
  followerId: string,
  result: FollowListResult,
): Promise<void> {
  await upsertFollowAuthors(prisma, result)
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    if (result.ids.length > 0) {
      await tx.follow.createMany({
        data: result.ids.map((followeeId) => ({
          followerId,
          followeeId,
          firstSeenAt: now,
          lastSeenAt: now,
        })),
        skipDuplicates: true,
      })
      await tx.follow.updateMany({
        where: { followerId, followeeId: { in: result.ids } },
        data: { lastSeenAt: now },
      })
    }

    // `reachedEnd` だけでは削除しない: `result.ids` が空だと `notIn: []` が全件一致になり、
    // 一時的な空応答 (レート制限や認証エラー) だけで記録済みの edge を全消去しかねないため、
    // 確認済みの id が 1 件以上ある場合のみ削除する。
    if (result.reachedEnd && result.ids.length > 0) {
      await tx.follow.deleteMany({
        where: { followerId, followeeId: { notIn: result.ids } },
      })
    }
  })
}

/**
 * {@link syncFollowing} の対称版: `followerId` の代わりに `followeeId` を固定する。
 * @param prisma - Prisma クライアント
 * @param followeeId - フォロワーリストの対象アカウント
 * @param result - 取得したフォロワーリスト
 */
export async function syncFollowers(
  prisma: PrismaClient,
  followeeId: string,
  result: FollowListResult,
): Promise<void> {
  await upsertFollowAuthors(prisma, result)
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    if (result.ids.length > 0) {
      await tx.follow.createMany({
        data: result.ids.map((followerId) => ({
          followerId,
          followeeId,
          firstSeenAt: now,
          lastSeenAt: now,
        })),
        skipDuplicates: true,
      })
      await tx.follow.updateMany({
        where: { followeeId, followerId: { in: result.ids } },
        data: { lastSeenAt: now },
      })
    }

    // `syncFollowing` 側の同じコメントを参照。
    if (result.reachedEnd && result.ids.length > 0) {
      await tx.follow.deleteMany({
        where: { followeeId, followerId: { notIn: result.ids } },
      })
    }
  })
}
