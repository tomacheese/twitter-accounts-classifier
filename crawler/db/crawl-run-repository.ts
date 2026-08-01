import type { Prisma, PrismaClient } from '../generated/prisma'

/**
 * The fixed set of situations `runCrawlCycle` records as a warning against a
 * `CrawlAccountRun`, one type per failure site: the three timeline fetches and the
 * per-author loop in `runAccountCycleBody`, plus the three steps of `syncFollowGraph`.
 */
export type CrawlWarningType =
  | 'recommended_timeline_failed'
  | 'following_timeline_failed'
  | 'trending_timeline_failed'
  | 'author_processing_failed'
  | 'own_account_sync_failed'
  | 'following_sync_failed'
  | 'followers_sync_failed'

/**
 * One structured warning recorded against a `CrawlAccountRun`. `errorMessage` carries the
 * underlying error's message so the cause is visible on the persisted row itself, without
 * cross-referencing server logs (which still receive the full `Error` object separately).
 * `username` identifies the login account being crawled, set for every type except
 * `author_processing_failed`, which instead identifies the failing author via `authorId`.
 */
export interface CrawlWarning {
  type: CrawlWarningType
  message: string
  username?: string
  authorId?: string
  errorMessage: string
  /**
   * The raw HTTP response body that caused the failure, when one was captured (see
   * `twitter/response-capture.ts`). Unlike `errorMessage`, which is only the JS error
   * text, this is what X's API actually returned - the one thing that lets a human
   * investigate the real response shape behind a library parse failure after the fact.
   */
  rawResponseSnippet?: string
}

export interface RecordCrawlAccountRunParams {
  crawlRunId: string
  username: string
  startedAt: Date
  finishedAt: Date
  status: string
  recommendedCount: number
  followingCount: number
  trendingCount: number
  replyCount: number
  profileCount: number
  labelsAppliedCount: number
  followingSynced: boolean
  followersSynced: boolean
  warnings: CrawlWarning[]
  errorMessage: string | null
}

/**
 * 再開する crawl run と、アカウントごとの最新試行の status。
 */
export interface CrawlRunStartResult {
  id: string
  latestAccountStatuses: Map<string, string>
}

/**
 * 単一の crawler プロセスだけが動作する環境で、中断された crawl run を再開し、存在しなければ新規に作成する。
 * @param prisma - the Prisma client
 * @param startedAt - 新規 run の開始時刻
 * @returns run ID とアカウントごとの最新試行の status
 */
export async function startOrResumeCrawlRun(
  prisma: PrismaClient,
  startedAt: Date,
): Promise<CrawlRunStartResult> {
  const existingRun = await prisma.crawlRun.findFirst({
    where: { status: 'running' },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  })
  if (existingRun) {
    const accountRuns = await prisma.$queryRaw<{ username: string; status: string }[]>`
      SELECT DISTINCT ON ("username") "username", "status"
      FROM "CrawlAccountRun"
      WHERE "crawlRunId" = ${existingRun.id}
      ORDER BY "username", "startedAt" DESC, "id" DESC
    `
    const latestAccountStatuses = new Map(
      accountRuns.map(({ username, status }) => [username, status]),
    )
    return { id: existingRun.id, latestAccountStatuses }
  }

  const run = await prisma.crawlRun.create({ data: { startedAt, status: 'running' } })
  return { id: run.id, latestAccountStatuses: new Map() }
}

/**
 * Updates a `CrawlRun` with its final `finishedAt` timestamp and status. Called either
 * once every configured account has been processed for the cycle (with the aggregated
 * status), or early with `'failed'` if an unexpected error escapes the cycle first.
 * @param prisma - the Prisma client
 * @param id - {@link startOrResumeCrawlRun} が返した `CrawlRun` の ID
 * @param finishedAt - when the cycle completed (or failed)
 * @param status - the run's final status ("success" | "partial" | "failed")
 */
export async function finishCrawlRun(
  prisma: PrismaClient,
  id: string,
  finishedAt: Date,
  status: string,
): Promise<void> {
  await prisma.crawlRun.update({ where: { id }, data: { finishedAt, status } })
}

/**
 * Records one account's outcome within a crawl cycle as a `CrawlAccountRun` row.
 * @param prisma - the Prisma client
 * @param params - every field of the row to create
 */
export async function recordCrawlAccountRun(
  prisma: PrismaClient,
  params: RecordCrawlAccountRunParams,
): Promise<void> {
  // `warnings` is a structured array, but Prisma's generated `InputJsonValue` union
  // requires an explicit cast to accept a plain array of objects as JSON input.
  await prisma.crawlAccountRun.create({
    data: { ...params, warnings: params.warnings as unknown as Prisma.InputJsonValue },
  })
}
