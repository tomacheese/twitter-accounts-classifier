import type { PrismaClient } from '../generated/prisma'

export interface BuildBlockRelationSummaryInput {
  generationId: string
  sourceWatermarkAt: Date
}

/**
 * Block を Account の screenName で正規化しつつ BlockRelationCurrent を構築する。
 * Block は statusChangedAt を持たないため、resolvedAt → missingSinceAt → lastSeenAt の
 * 優先順で「直近の状態変化に最も近い時刻」を代用する。
 * @param prisma - Prisma クライアント
 * @param input - 対象 generationId と検索基準時刻
 * @returns 作成した行数
 */
export async function buildBlockRelationSummary(
  prisma: PrismaClient,
  input: BuildBlockRelationSummaryInput,
): Promise<{ rowCount: number }> {
  const blocks = await prisma.block.findMany({
    include: {
      blocker: { select: { screenName: true } },
      blocked: { select: { screenName: true } },
    },
  })
  if (blocks.length === 0) return { rowCount: 0 }

  await prisma.blockRelationCurrent.createMany({
    data: blocks.map((block) => ({
      generationId: input.generationId,
      blockId: block.id,
      normalizedBlockerScreenName: block.blocker.screenName.toLowerCase(),
      normalizedBlockedScreenName: block.blocked.screenName.toLowerCase(),
      status: block.status,
      statusChangedAt: block.resolvedAt ?? block.missingSinceAt ?? block.lastSeenAt,
      sourceWatermarkAt: input.sourceWatermarkAt,
    })),
  })

  return { rowCount: blocks.length }
}
