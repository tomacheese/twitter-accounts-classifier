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
 * 逆に再び観測された行は active へ戻す。
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

        // 一度 missing/resolved へ進んだ行は skipDuplicates の createMany では作り直されず、
        // 再び観測されても status が戻らないため、ここで正本状態を復元する。
        const rediscovered = await tx.block.findMany({
          where: {
            blockerId,
            blockedId: { in: result.ids },
            OR: [{ status: { not: 'active' } }, { consecutiveMissingCount: { gt: 0 } }],
          },
          select: { id: true, status: true },
        })
        if (rediscovered.length > 0) {
          await tx.block.updateMany({
            where: { id: { in: rediscovered.map((block) => block.id) } },
            data: {
              status: 'active',
              consecutiveMissingCount: 0,
              missingSinceAt: null,
              resolvedAt: null,
              lastCheckedAt: now,
            },
          })

          const statusChanges = rediscovered.filter((block) => block.status !== 'active')
          if (statusChanges.length > 0) {
            await tx.blockStateChange.createMany({
              data: statusChanges.map((block) => ({
                blockId: block.id,
                fromStatus: block.status,
                toStatus: 'active',
                changedAt: now,
              })),
            })
          }
        }
      }

      if (!isCompleteSync) return

      const existingBlocks = await tx.block.findMany({
        where: { blockerId, blockedId: { notIn: result.ids } },
      })
      const changes = existingBlocks
        .map((block) => {
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
            return null
          }
          return {
            id: block.id,
            fromStatus: block.status,
            toStatus: reconciliation.nextStatus,
            consecutiveMissingCount: reconciliation.consecutiveMissingCount,
            missingSinceAt:
              reconciliation.nextStatus === 'missing' && block.status !== 'missing'
                ? now
                : block.missingSinceAt,
            resolvedAt: reconciliation.nextStatus === 'resolved' ? now : null,
          }
        })
        .filter((change): change is NonNullable<typeof change> => change !== null)

      if (changes.length === 0) return

      // 変更対象を 1 件ずつ update/create すると HDD 環境ではブロック件数に比例して
      // トランザクションが長引くため、UNNEST を使い update・insert をそれぞれ 1 回にまとめる。
      await tx.$executeRaw`
        UPDATE "Block" AS b
        SET
          status = data.status,
          "consecutiveMissingCount" = data."consecutiveMissingCount",
          "lastCheckedAt" = ${now},
          "missingSinceAt" = data."missingSinceAt",
          "resolvedAt" = data."resolvedAt"
        FROM (
          SELECT * FROM UNNEST(
            ${changes.map((change) => change.id)}::text[],
            ${changes.map((change) => change.toStatus)}::text[],
            ${changes.map((change) => change.consecutiveMissingCount)}::int[],
            ${changes.map((change) => change.missingSinceAt)}::timestamptz[],
            ${changes.map((change) => change.resolvedAt)}::timestamptz[]
          ) AS t(id, status, "consecutiveMissingCount", "missingSinceAt", "resolvedAt")
        ) AS data
        WHERE b.id = data.id
      `

      await tx.blockStateChange.createMany({
        data: changes.map((change) => ({
          blockId: change.id,
          fromStatus: change.fromStatus,
          toStatus: change.toStatus,
          changedAt: now,
        })),
      })
    },
    // 変更行の update・insert をそれぞれ 1 クエリへまとめたため、ブロック件数に比例して
    // 伸びるのは読み取り (findMany) のみになる。HDD の I/O 滞留を吸収する余地として
    // `./labeling-follow-sample-repository` と同じ 15 秒を踏襲する。
    { maxWait: 15_000, timeout: 15_000 },
  )
}
