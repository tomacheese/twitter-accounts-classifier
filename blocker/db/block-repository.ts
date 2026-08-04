import type { PrismaClient } from '../generated/prisma'

/**
 * 次回の `crawler` によるブロック一覧同期を待たずに、同一サイクル内での二重ブロックや
 * 別アカウントへの重複処理判定に反映させるため、成功直後に即時 upsert する。
 * @param prisma - Prisma クライアント
 * @param blockerId - ブロックを実行したアカウント
 * @param blockedId - ブロックされたアカウント
 */
export async function recordSuccessfulBlock(
  prisma: PrismaClient,
  blockerId: string,
  blockedId: string,
): Promise<void> {
  const now = new Date()
  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    create: { blockerId, blockedId, firstSeenAt: now, lastSeenAt: now },
    update: { lastSeenAt: now },
  })
}
