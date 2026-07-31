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
 * Creates a `CrawlRun` row marking the start of one full crawl cycle
 * (`runCrawlCycle`). `status` starts as the "running" placeholder and is
 * corrected once the cycle finishes or fails, via {@link finishCrawlRun}.
 * @param prisma - the Prisma client
 * @param startedAt - when the cycle began
 * @returns the id of the created `CrawlRun`, to attach child `CrawlAccountRun`s to
 */
export async function startCrawlRun(
  prisma: PrismaClient,
  startedAt: Date,
): Promise<{ id: string }> {
  const run = await prisma.crawlRun.create({ data: { startedAt, status: 'running' } })
  return { id: run.id }
}

/**
 * Updates a `CrawlRun` with its final `finishedAt` timestamp and status. Called either
 * once every configured account has been processed for the cycle (with the aggregated
 * status), or early with `'failed'` if an unexpected error escapes the cycle first.
 * @param prisma - the Prisma client
 * @param id - the `CrawlRun` id returned by {@link startCrawlRun}
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
