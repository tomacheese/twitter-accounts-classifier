import type { PrismaClient } from '../generated/prisma'

/**
 * buildBlockRelationSummary の入力。
 */
export interface BuildBlockRelationSummaryInput {
  /** 書き込み先の generationId。 */
  generationId: string
  /** 集計の基準時刻。 */
  sourceWatermarkAt: Date
  /** 1 ページあたりの Block 取得件数。 */
  pageSize?: number
}

/**
 * Block を Account の screenName で正規化しつつ BlockRelationCurrent を構築する。
 * Block は statusChangedAt を持たないため、
 * resolvedAt → missingSinceAt → lastSeenAt の優先順で直近の状態変化時刻を代用する。
 * Block を大量件数でも一括ロードせずカーソルページングで処理するため、
 * ページサイズを固定値ではなくオプション化してテストで小さい値へ差し替え可能にする。
 * @param prisma - Prisma クライアント
 * @param input - 対象 generationId と検索基準時刻
 * @returns 作成した行数
 */
export async function buildBlockRelationSummary(
  prisma: PrismaClient,
  input: BuildBlockRelationSummaryInput,
): Promise<{ rowCount: number }> {
  const pageSize = input.pageSize ?? 2000
  let rowCount = 0
  let cursor: string | undefined

  for (;;) {
    const blocks = await prisma.block.findMany({
      take: pageSize,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      include: {
        blocker: { select: { screenName: true } },
        blocked: { select: { screenName: true } },
      },
    })
    if (blocks.length === 0) break

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

    rowCount += blocks.length
    cursor = blocks.at(-1)?.id
    if (blocks.length < pageSize) break
  }

  return { rowCount }
}
