import type { PrismaClient } from '../../generated/prisma'

/** 一覧ページに表示する1行分のブロック関係。 */
export interface BlockListItem {
  id: string
  blockerId: string
  blockerScreenName: string
  blockedId: string
  blockedScreenName: string
  firstSeenAt: Date
  lastSeenAt: Date
}

/** ページネーション向けに、1ページ分のブロック関係一覧と総件数をまとめたもの。 */
export interface BlockListResult {
  items: BlockListItem[]
  totalCount: number
}

/**
 * 現在成立しているブロック関係を、直近に観測された順にページネーションして読み込む。
 * ブロック関係は `CrawlRun`/`BlockRun` の実行履歴より件数が増えやすいため、
 * `getAllBlockRuns` のような全件取得ではなくページネーションを必須にしている。
 * @param prisma - クエリを実行する Prisma クライアント
 * @param filters - ページネーションの条件
 * @returns 該当ページのブロック関係一覧と総件数
 */
export async function listBlocks(
  prisma: PrismaClient,
  filters: { page: number; pageSize: number },
): Promise<BlockListResult> {
  const [rows, totalCount] = await Promise.all([
    prisma.block.findMany({
      orderBy: { lastSeenAt: 'desc' },
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
      include: { blocker: true, blocked: true },
    }),
    prisma.block.count(),
  ])

  return {
    items: rows.map((row) => ({
      id: row.id,
      blockerId: row.blockerId,
      blockerScreenName: row.blocker.screenName,
      blockedId: row.blockedId,
      blockedScreenName: row.blocked.screenName,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
    })),
    totalCount,
  }
}
