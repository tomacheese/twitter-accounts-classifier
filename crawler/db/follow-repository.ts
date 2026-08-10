import type { PrismaClient } from '../generated/prisma'
import { upsertAccountsBulk } from './account-repository'
import type { FollowListResult } from '../twitter/follows'

async function upsertFollowAuthors(
  prisma: PrismaClient,
  result: FollowListResult,
): Promise<Set<string>> {
  return upsertAccountsBulk(prisma, result.authors)
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
  const upsertedIds = await upsertFollowAuthors(prisma, result)
  // Account upsert が失敗した id は外部キー制約に違反するため、edge 同期・complete-sync 判定から除外する。
  const safeIds = result.ids.filter((id) => upsertedIds.has(id))
  const isCompleteObservation = result.ids.every((id) => upsertedIds.has(id))
  const now = new Date()

  await prisma.$transaction(
    async (tx) => {
      if (safeIds.length > 0) {
        await tx.follow.createMany({
          data: safeIds.map((followeeId) => ({
            followerId,
            followeeId,
            firstSeenAt: now,
            lastSeenAt: now,
          })),
          skipDuplicates: true,
        })
        await tx.follow.updateMany({
          where: { followerId, followeeId: { in: safeIds } },
          data: { lastSeenAt: now },
        })
      }

      // `reachedEnd` だけでは削除しない: 一時的な空応答や Account upsert 失敗だけで
      // 記録済みの edge を全消去しかねないため、全件を確認できた場合のみ削除する。
      if (result.reachedEnd && safeIds.length > 0 && isCompleteObservation) {
        await tx.follow.deleteMany({
          where: { followerId, followeeId: { notIn: safeIds } },
        })
      }
    },
    // `./labeling-follow-sample-repository` の同じコメントを参照。
    { maxWait: 15_000, timeout: 15_000 },
  )
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
  const upsertedIds = await upsertFollowAuthors(prisma, result)
  const safeIds = result.ids.filter((id) => upsertedIds.has(id))
  const isCompleteObservation = result.ids.every((id) => upsertedIds.has(id))
  const now = new Date()

  await prisma.$transaction(
    async (tx) => {
      if (safeIds.length > 0) {
        await tx.follow.createMany({
          data: safeIds.map((followerId) => ({
            followerId,
            followeeId,
            firstSeenAt: now,
            lastSeenAt: now,
          })),
          skipDuplicates: true,
        })
        await tx.follow.updateMany({
          where: { followeeId, followerId: { in: safeIds } },
          data: { lastSeenAt: now },
        })
      }

      // `syncFollowing` 側の同じコメントを参照。
      if (result.reachedEnd && safeIds.length > 0 && isCompleteObservation) {
        await tx.follow.deleteMany({
          where: { followeeId, followerId: { notIn: safeIds } },
        })
      }
    },
    // `./labeling-follow-sample-repository` の同じコメントを参照。
    { maxWait: 15_000, timeout: 15_000 },
  )
}
