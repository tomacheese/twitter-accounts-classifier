import type { PrismaClient } from '../generated/prisma'

/**
 * 次回の `crawler` によるブロック一覧同期を待たずに、同一サイクル内での二重ブロックや
 * 別アカウントへの重複処理判定に反映させるため、成功直後に即時 upsert する。
 * crawler 側の sync は `skipDuplicates` で既存行を上書きしないため、
 * この行の発生源を正しく残すのはここが唯一の機会になる。
 * @param prisma - Prisma クライアント
 * @param blockerId - ブロックを実行したアカウント
 * @param blockedId - ブロックされたアカウント
 * @param blockAccountRunId - この block を成功させた BlockAccountRun の ID
 */
export async function recordSuccessfulBlock(
  prisma: PrismaClient,
  blockerId: string,
  blockedId: string,
  blockAccountRunId: string,
): Promise<void> {
  const now = new Date()
  await prisma.block.upsert({
    where: { blockerId_blockedId: { blockerId, blockedId } },
    create: {
      blockerId,
      blockedId,
      firstSeenAt: now,
      lastSeenAt: now,
      sourceKind: 'blocker',
      sourceId: blockAccountRunId,
    },
    update: { lastSeenAt: now },
  })
}
