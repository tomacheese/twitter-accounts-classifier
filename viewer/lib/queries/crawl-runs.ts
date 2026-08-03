import type { CrawlAccountRun, CrawlRun, PrismaClient } from '../../generated/prisma'

/** クロール実行履歴ページに表示する `CrawlAccountRun` の1行分。 */
export type CrawlAccountRunSummary = CrawlAccountRun

/** 子である `CrawlAccountRun` を含む `CrawlRun`。 */
export interface CrawlRunSummary extends CrawlRun {
  accountRuns: CrawlAccountRunSummary[]
}

/** 軽量な履歴一覧向けに、アカウント件数のみを持つ `CrawlRun`。 */
export interface CrawlRunListItem extends CrawlRun {
  accountRunCount: number
}

/**
 * ダッシュボードの概要向けに、直近のクロール実行をアカウント件数のみで読み込む。
 * アカウント単位の詳細は意図的に含めない (詳細は {@link getCrawlRunDetail})。
 * 各実行に蓄積したアカウント数によらず、このクエリを軽量に保つため。
 * @param prisma - クエリを実行する Prisma クライアント
 * @param limit - 取得する実行数の上限
 * @returns 新しい順で最大 limit 件の実行 (アカウント件数のみ)
 */
export async function getRecentCrawlRuns(
  prisma: PrismaClient,
  limit: number,
): Promise<CrawlRunListItem[]> {
  const runs = await prisma.crawlRun.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit,
    include: { _count: { select: { accountRuns: true } } },
  })
  return runs.map(({ _count, ...run }) => ({ ...run, accountRunCount: _count.accountRuns }))
}

/**
 * 履歴一覧ページ向けに、クロール実行の全履歴をアカウント件数のみで読み込む。
 * アカウント単位の詳細を含めない理由は {@link getRecentCrawlRuns} と同じ。
 * 実行自体はページネーションしていないため、クロールを重ねるほど件数は増え続ける。
 * @param prisma - クエリを実行する Prisma クライアント
 * @returns 新しい順の全実行 (アカウント件数のみ)
 */
export async function getAllCrawlRuns(prisma: PrismaClient): Promise<CrawlRunListItem[]> {
  const runs = await prisma.crawlRun.findMany({
    orderBy: { startedAt: 'desc' },
    include: { _count: { select: { accountRuns: true } } },
  })
  return runs.map(({ _count, ...run }) => ({ ...run, accountRunCount: _count.accountRuns }))
}

/**
 * 実行ごとの詳細ページ向けに、単一のクロール実行をアカウント単位の内訳付きで読み込む。
 * アカウント単位の一覧は startedAt 順に並べ、同着時は id をタイブレークに使う。
 * 再読み込みのたびに表示順が変わらないようにするためで、一覧クエリ全般の方針に合わせている。
 * @param prisma - クエリを実行する Prisma クライアント
 * @param id - `CrawlRun` の id
 * @returns アカウント単位の実行を含む実行。該当する id がなければ `null`
 */
export async function getCrawlRunDetail(
  prisma: PrismaClient,
  id: string,
): Promise<CrawlRunSummary | null> {
  return prisma.crawlRun.findUnique({
    where: { id },
    include: { accountRuns: { orderBy: [{ startedAt: 'asc' }, { id: 'asc' }] } },
  })
}
