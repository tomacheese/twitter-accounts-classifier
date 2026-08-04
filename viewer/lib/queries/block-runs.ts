import type { BlockAccountRun, BlockRun, PrismaClient } from '../../generated/prisma'

/** 一覧ページ向けに、アカウント件数のみを持つ `BlockRun`。 */
export interface BlockRunListItem extends BlockRun {
  accountRunCount: number
}

/** 詳細ページで表示する、失敗した `BlockAction` 1件分。 */
export interface BlockActionFailure {
  id: string
  blockedId: string
  blockedScreenName: string
  labelKey: string
  confidence: number
  errorMessage: string | null
}

/** 詳細ページに表示する `BlockAccountRun` の1行分。失敗した `BlockAction` のみを持つ。 */
export interface BlockAccountRunDetail extends BlockAccountRun {
  failures: BlockActionFailure[]
}

/** 子である `BlockAccountRun` を含む `BlockRun`。 */
export interface BlockRunDetail extends BlockRun {
  accountRuns: BlockAccountRunDetail[]
}

/**
 * 一覧ページ向けに、blocker 実行の全履歴をアカウント件数のみで読み込む。
 * 実行を重ねるほど件数は増え続けるが、`CrawlRun` の履歴一覧と同様の増加ペースであるため、
 * ページネーションはしていない。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns 新しい順の全実行 (アカウント件数のみ)
 */
export async function getAllBlockRuns(prisma: PrismaClient): Promise<BlockRunListItem[]> {
  const runs = await prisma.blockRun.findMany({
    orderBy: { startedAt: 'desc' },
    include: { _count: { select: { accountRuns: true } } },
  })
  return runs.map(({ _count, ...run }) => ({ ...run, accountRunCount: _count.accountRuns }))
}

/**
 * 詳細ページ向けに、単一の blocker 実行をアカウント単位の内訳付きで読み込む。
 * 成功した `BlockAction` は `blockedCount` の集計値で十分表現できており、
 * 個別に一覧すると詳細ページの表示件数が実行のたびに増え続けてしまうため、
 * 失敗した `BlockAction` のみを含める。
 * @param prisma - クエリを実行する Prisma クライアント
 * @param id - `BlockRun` の id
 * @returns アカウント単位の実行を含む実行。該当する id がなければ `null`
 */
export async function getBlockRunDetail(
  prisma: PrismaClient,
  id: string,
): Promise<BlockRunDetail | null> {
  const run = await prisma.blockRun.findUnique({
    where: { id },
    include: {
      accountRuns: {
        orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
        include: {
          actions: {
            where: { result: 'failure' },
            include: { blocked: true, labelDefinition: true },
          },
        },
      },
    },
  })
  if (!run) return null

  return {
    ...run,
    accountRuns: run.accountRuns.map(({ actions, ...accountRun }) => ({
      ...accountRun,
      failures: actions.map((action) => ({
        id: action.id,
        blockedId: action.blockedId,
        blockedScreenName: action.blocked.screenName,
        labelKey: action.labelDefinition.key,
        confidence: action.confidence,
        errorMessage: action.errorMessage,
      })),
    })),
  }
}
