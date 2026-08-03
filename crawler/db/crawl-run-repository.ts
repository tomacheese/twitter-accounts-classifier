import { Logger } from '@book000/node-utils'
import type { Prisma, PrismaClient } from '../generated/prisma'

const logger = Logger.configure('crawl-run-repository')

export type CrawlWarningType =
  | 'recommended_timeline_failed'
  | 'following_timeline_failed'
  | 'trending_timeline_failed'
  | 'author_processing_failed'
  | 'own_account_sync_failed'
  | 'following_sync_failed'
  | 'followers_sync_failed'

/**
 * `errorMessage` は元のエラーメッセージだけを保持し、
 * `Error` オブジェクト全体はサーバーログ側に任せる: 永続化される行自体を大きくしすぎないため。
 */
export interface CrawlWarning {
  type: CrawlWarningType
  message: string
  username?: string
  authorId?: string
  errorMessage: string
  /**
   * `errorMessage` (JS のエラー文言のみ) では、
   * ライブラリのパース失敗の背後にある実際のレスポンス形状を後から調査できないため、
   * キャプチャできた場合のみ生の HTTP レスポンス本文も保持する。
   */
  rawResponseSnippet?: string
  /** author 処理の ResponseError に限り記録する安全な HTTP 診断情報。 */
  httpStatus?: number
  retryAfterSeconds?: number
  rateLimitLimit?: number
  rateLimitRemaining?: number
  rateLimitReset?: number
  /**
   * この warning を push した時点の APPLICATION_VERSION。
   * phase 単位の再開 (中断・redeploy を挟んで別プロセスが後続 phase を完了するケース) では `CrawlAccountRun.appVersion` (行を最終確定させたビルド) と一致しないことがあるため、
   * warning ごとに発生源のビルドを保持する。
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
   * crawler image に埋め込まれた APPLICATION_VERSION。値が取れない場合は "unknown"。
   * 行を最終確定させたビルドを表す — 個々の warning を生んだビルドは `CrawlWarning.appVersion` を見る。
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
 * アカウント処理が進む限り定期的に呼び出す必要がある:
 * 放置判定 (startOrResumeCrawlRun) がこの値を基準にするため。
 * @param prisma - Prisma クライアント
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
 * @param prisma - Prisma クライアント
 * @param id - {@link startOrResumeCrawlRun} が返した `CrawlRun` の ID
 * @param finishedAt - サイクルが完了 (または失敗) した時刻
 * @param status - run の最終 status ("success" | "partial" | "failed")
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
 * @param prisma - Prisma クライアント
 * @param params - 作成する行の全フィールド
 */
export async function recordCrawlAccountRun(
  prisma: PrismaClient,
  params: RecordCrawlAccountRunParams,
): Promise<void> {
  // `warnings` は構造化された配列だが、
  // Prisma が生成する `InputJsonValue` union にそのまま渡せないため、
  // 明示的なキャストが必要になる。
  await prisma.crawlAccountRun.create({
    data: { ...params, warnings: params.warnings as unknown as Prisma.InputJsonValue },
  })
}

/**
 * phase の結果を永続化してから checkpoint を記録するため、
 * 再開時は存在する phase を安全に skip できる。
 * @param prisma - Prisma クライアント
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
 * 停止後に完了済み phase を再実行した場合は、
 * 曖昧な 2 件目の checkpoint を作らず既存 payload を置き換える。
 * @param prisma - Prisma クライアント
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
 * 通常の cycle 完了後、再開専用の checkpoint payload と label の重複防止 claim を削除する。
 * 予期しない例外で終了した run は、後続プロセスが再開できるようこれらの状態を維持する。
 * @param prisma - Prisma クライアント
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

/**
 * 単一の crawler プロセスだけが動作する前提で運用する: 複数プロセスの同時実行は想定しない。
 * `lastHeartbeatAt` が `staleThresholdMs` を超えて更新されていない `running` 行は、
 * 正常終了できなかったものとみなして `failed` に確定する。
 * @param prisma - Prisma クライアント
 * @param startedAt - 新規 run の開始時刻
 * @param staleThresholdMs - 放置判定のしきい値 (ミリ秒)。`startedAt - lastHeartbeatAt` がこれを超えていれば放置とみなす
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

    logger.warn(
      `Abandoning stale crawl run ${existingRun.id}: last heartbeat at ` +
        `${existingRun.lastHeartbeatAt.toISOString()}, exceeding staleThresholdMs=${staleThresholdMs}`,
    )
    try {
      // lastHeartbeatAt (この行が最後に生存を示した時刻) を finishedAt とする。
      // startedAt (新しい cycle の開始時刻) を使うと、
      // 実際にはとうに停止していた run の duration が放置時間の分だけ水増しされてしまう。
      await finishCrawlRun(prisma, existingRun.id, existingRun.lastHeartbeatAt, 'failed')
      await clearCrawlAccountCheckpoints(prisma, existingRun.id)
    } catch (error) {
      // 片付けに失敗しても新しい run の作成は続行する。
      // 放置された行の checkpoint / label claim が残り続けるだけで、
      // 後続の cycle には影響しない。
      logger.error(`Failed to finalize abandoned crawl run ${existingRun.id}`, error as Error)
    }
  }

  const run = await prisma.crawlRun.create({
    data: { startedAt, lastHeartbeatAt: startedAt, status: 'running' },
  })
  return { id: run.id, latestAccountStatuses: new Map() }
}
