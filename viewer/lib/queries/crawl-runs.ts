import type { CrawlAccountRun, CrawlRun, PrismaClient } from '../../generated/prisma'

/** One `CrawlAccountRun` row, as displayed in the crawl run history page. */
export type CrawlAccountRunSummary = CrawlAccountRun

/** A `CrawlRun` row together with its child `CrawlAccountRun` rows. */
export interface CrawlRunSummary extends CrawlRun {
  accountRuns: CrawlAccountRunSummary[]
}

/** A `CrawlRun` row with only its account count, for the lightweight history list. */
export interface CrawlRunListItem extends CrawlRun {
  accountRunCount: number
}

/**
 * Loads the most recent crawl runs, with only their account count, for the
 * dashboard's summary section. Each run's account-level detail is deliberately
 * left out here (see {@link getCrawlRunDetail}) so this query stays cheap
 * regardless of how many accounts have accumulated on each run.
 * @param prisma - the Prisma client to query
 * @param limit - the maximum number of runs to return
 * @returns up to `limit` runs, most recent first, with only their account count
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
 * Loads the full crawl run history for the list page. Each run's account-level
 * detail is deliberately left out here (see {@link getCrawlRunDetail}) so this
 * query stays cheap regardless of how many accounts have accumulated on each run
 * (the runs themselves are not paginated, so this list still grows with the
 * number of crawl cycles that have run).
 * @param prisma - the Prisma client to query
 * @returns every run, most recent first, with only its account count
 */
export async function getAllCrawlRuns(prisma: PrismaClient): Promise<CrawlRunListItem[]> {
  const runs = await prisma.crawlRun.findMany({
    orderBy: { startedAt: 'desc' },
    include: { _count: { select: { accountRuns: true } } },
  })
  return runs.map(({ _count, ...run }) => ({ ...run, accountRunCount: _count.accountRuns }))
}

/**
 * Loads a single crawl run together with its full per-account breakdown, for the
 * run's dedicated detail page. Account runs are ordered by start time (with `id`
 * as a tiebreaker) so the per-account table renders in a stable order across
 * reloads, matching this project's convention for list queries.
 * @param prisma - the Prisma client to query
 * @param id - the `CrawlRun` id
 * @returns the run with its account runs, or `null` if no run has that id
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
