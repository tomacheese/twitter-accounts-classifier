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
  /** author 処理の ResponseError に限り記録する安全な HTTP 診断情報。 */
  httpStatus?: number
  retryAfterSeconds?: number
  rateLimitLimit?: number
  rateLimitRemaining?: number
  rateLimitReset?: number
  /**
   * この warning を push した時点の APPLICATION_VERSION。phase 単位の再開 (中断・redeploy を
   * 挟んで別プロセスが後続 phase を完了するケース) では `CrawlAccountRun.appVersion` (行を最終
   * 確定させたビルド) と一致しないことがあるため、warning ごとに発生源のビルドを保持する。
   */
  appVersion?: string
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
  /**
   * crawler image に埋め込まれた APPLICATION_VERSION。値が取れない場合は "unknown"。行を最終
   * 確定させたビルドを表す — 個々の warning を生んだビルドは `CrawlWarning.appVersion` を見る。
   */
  appVersion: string
}

export const CRAWL_ACCOUNT_CHECKPOINT_PHASES = [
  'timelines',
  'authors',
  'following',
  'followers',
] as const

export type CrawlAccountCheckpointPhase = (typeof CRAWL_ACCOUNT_CHECKPOINT_PHASES)[number]

export interface CrawlAccountCheckpointParams {
  crawlRunId: string
  username: string
  phase: CrawlAccountCheckpointPhase
  data: Prisma.InputJsonValue
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
 * 既存の `running` 行が見つかっても、その `lastHeartbeatAt` が `staleThresholdMs` を超えて
 * 更新されていなければ放置されたものとみなし、`failed` として確定した上で新しい行を作る。
 * @param prisma - the Prisma client
 * @param startedAt - 新規 run の開始時刻
 * @param staleThresholdMs - 放置判定のしきい値 (ミリ秒)。`startedAt - lastHeartbeatAt` がこれを
 *   超えていれば放置とみなす
 * @returns run ID とアカウントごとの最新試行の status
 */
export async function startOrResumeCrawlRun(
  prisma: PrismaClient,
  startedAt: Date,
  staleThresholdMs: number,
): Promise<CrawlRunStartResult> {
  const existingRun = await prisma.crawlRun.findFirst({
    where: { status: 'running' },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, lastHeartbeatAt: true },
  })

  if (existingRun) {
    const isStale = startedAt.getTime() - existingRun.lastHeartbeatAt.getTime() > staleThresholdMs
    if (!isStale) {
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

    // 放置された行を failed として確定し、二度と参照されないチェックポイント・
    // label claim を片付ける。この行の id は以降どこからも再利用されない。
    await finishCrawlRun(prisma, existingRun.id, startedAt, 'failed')
    await clearCrawlAccountCheckpoints(prisma, existingRun.id)
  }

  const run = await prisma.crawlRun.create({
    data: { startedAt, lastHeartbeatAt: startedAt, status: 'running' },
  })
  return { id: run.id, latestAccountStatuses: new Map() }
}

/**
 * 実行中の CrawlRun の生存を記録する。放置判定 (startOrResumeCrawlRun) は
 * この値を基準にするため、アカウント処理が進む限り定期的に呼び出す必要がある。
 * @param prisma - the Prisma client
 * @param id - 対象の CrawlRun ID
 * @param at - 記録する時刻
 */
export async function touchCrawlRunHeartbeat(
  prisma: PrismaClient,
  id: string,
  at: Date,
): Promise<void> {
  await prisma.crawlRun.update({ where: { id }, data: { lastHeartbeatAt: at } })
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

/**
 * crawl run 内のログインアカウント 1 件について、完了済み checkpoint を取得する。phase の
 * 結果を永続化してから checkpoint を記録するため、再開時は存在する phase を安全に skip できる。
 * @param prisma - Prisma client
 * @param crawlRunId - 取得対象の crawl run
 * @param username - 設定済みのログインアカウント
 * @returns 完了済み checkpoint の phase と payload の対応
 */
export async function loadCrawlAccountCheckpoints(
  prisma: PrismaClient,
  crawlRunId: string,
  username: string,
): Promise<Map<CrawlAccountCheckpointPhase, Prisma.JsonValue>> {
  const checkpoints = await prisma.crawlAccountCheckpoint.findMany({
    where: { crawlRunId, username },
    select: { phase: true, data: true },
  })
  return new Map(
    checkpoints
      .filter(
        (checkpoint): checkpoint is typeof checkpoint & { phase: CrawlAccountCheckpointPhase } =>
          (CRAWL_ACCOUNT_CHECKPOINT_PHASES as readonly string[]).includes(checkpoint.phase),
      )
      .map((checkpoint) => [checkpoint.phase, checkpoint.data]),
  )
}

/**
 * アカウントの phase の永続化済み結果を atomically に記録する。停止後に完了済み phase を再実行
 * した場合は、曖昧な 2 件目の checkpoint を作らず既存 payload を置き換える。
 * @param prisma - Prisma client
 * @param params - checkpoint の識別子と JSON payload
 */
export async function completeCrawlAccountCheckpoint(
  prisma: PrismaClient,
  params: CrawlAccountCheckpointParams,
): Promise<void> {
  const { crawlRunId, username, phase, data } = params
  await prisma.crawlAccountCheckpoint.upsert({
    where: { crawlRunId_username_phase: { crawlRunId, username, phase } },
    create: { crawlRunId, username, phase, data },
    update: { data, completedAt: new Date() },
  })
}

/**
 * 通常の cycle 完了後、再開専用の checkpoint payload と label の重複防止 claim を削除する。予期しない
 * 例外で終了した run は、後続プロセスが再開できるようこれらの状態を維持する。
 * @param prisma - Prisma client
 * @param crawlRunId - 最終化済みの crawl run
 */
export async function clearCrawlAccountCheckpoints(
  prisma: PrismaClient,
  crawlRunId: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.crawlAccountCheckpoint.deleteMany({ where: { crawlRunId } }),
    prisma.crawlAccountLabelRun.deleteMany({ where: { crawlRunId } }),
  ])
}
