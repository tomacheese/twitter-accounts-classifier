import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '../generated/prisma'
import { upsertAccountsBulk } from './account-repository'
import type { FollowListResult } from '../twitter/follows'

interface FollowEdge {
  followerId: string
  followeeId: string
}

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
  const safeIds = [...new Set(result.ids.filter((id) => upsertedIds.has(id)))]
  const isCompleteObservation = result.ids.every((id) => upsertedIds.has(id))
  const now = new Date()

  await prisma.$transaction(
    async (tx) => {
      if (safeIds.length > 0) {
        const newIds = safeIds.map(() => randomUUID())
        const addedEdges = await tx.$queryRaw<FollowEdge[]>`
          INSERT INTO "Follow" ("id", "followerId", "followeeId", "firstSeenAt", "lastSeenAt")
          SELECT input."id", ${followerId}, input."followeeId", ${now}, ${now}
          FROM UNNEST(${newIds}::text[], ${safeIds}::text[]) AS input("id", "followeeId")
          ON CONFLICT ("followerId", "followeeId") DO NOTHING
          RETURNING "followerId", "followeeId"
        `
        if (addedEdges.length > 0) {
          await tx.followStateChange.createMany({
            data: addedEdges.map((edge) => ({ ...edge, changeType: 'followed', observedAt: now })),
          })
        }
        await tx.follow.updateMany({
          where: { followerId, followeeId: { in: safeIds } },
          data: { lastSeenAt: now },
        })
      }

      // `reachedEnd` だけでは削除しない: 一時的な空応答や Account upsert 失敗だけで
      // 記録済みの edge を全消去しかねないため、全件を確認できた場合のみ削除する。
      if (result.reachedEnd && safeIds.length > 0 && isCompleteObservation) {
        const removedEdges = await tx.$queryRaw<FollowEdge[]>`
          DELETE FROM "Follow"
          WHERE "followerId" = ${followerId} AND "followeeId" <> ALL(${safeIds}::text[])
          RETURNING "followerId", "followeeId"
        `
        if (removedEdges.length > 0) {
          await tx.followStateChange.createMany({
            data: removedEdges.map((edge) => ({
              ...edge,
              changeType: 'unfollowed',
              observedAt: now,
            })),
          })
        }
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
  const safeIds = [...new Set(result.ids.filter((id) => upsertedIds.has(id)))]
  const isCompleteObservation = result.ids.every((id) => upsertedIds.has(id))
  const now = new Date()

  await prisma.$transaction(
    async (tx) => {
      if (safeIds.length > 0) {
        const newIds = safeIds.map(() => randomUUID())
        const addedEdges = await tx.$queryRaw<FollowEdge[]>`
          INSERT INTO "Follow" ("id", "followerId", "followeeId", "firstSeenAt", "lastSeenAt")
          SELECT input."id", input."followerId", ${followeeId}, ${now}, ${now}
          FROM UNNEST(${newIds}::text[], ${safeIds}::text[]) AS input("id", "followerId")
          ON CONFLICT ("followerId", "followeeId") DO NOTHING
          RETURNING "followerId", "followeeId"
        `
        if (addedEdges.length > 0) {
          await tx.followStateChange.createMany({
            data: addedEdges.map((edge) => ({ ...edge, changeType: 'followed', observedAt: now })),
          })
        }
        await tx.follow.updateMany({
          where: { followeeId, followerId: { in: safeIds } },
          data: { lastSeenAt: now },
        })
      }

      // `syncFollowing` 側の同じコメントを参照。
      if (result.reachedEnd && safeIds.length > 0 && isCompleteObservation) {
        const removedEdges = await tx.$queryRaw<FollowEdge[]>`
          DELETE FROM "Follow"
          WHERE "followeeId" = ${followeeId} AND "followerId" <> ALL(${safeIds}::text[])
          RETURNING "followerId", "followeeId"
        `
        if (removedEdges.length > 0) {
          await tx.followStateChange.createMany({
            data: removedEdges.map((edge) => ({
              ...edge,
              changeType: 'unfollowed',
              observedAt: now,
            })),
          })
        }
      }
    },
    // `./labeling-follow-sample-repository` の同じコメントを参照。
    { maxWait: 15_000, timeout: 15_000 },
  )
}
