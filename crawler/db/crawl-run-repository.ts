import { Logger } from '@book000/node-utils'
import type { Prisma, PrismaClient } from '../generated/prisma'
import { enqueueWorkItem } from './analysis-work-item-repository'

const logger = Logger.configure('crawl-run-repository')

export type CrawlWarningType =
  | 'recommended_timeline_failed'
  | 'following_timeline_failed'
  | 'trending_timeline_failed'
  | 'author_processing_failed'
  | 'own_account_sync_failed'
  | 'following_sync_failed'
  | 'followers_sync_failed'
  | 'blocks_sync_failed'
  | 'labeling_follow_sample_failed'

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
   * phase 単位の再開 (中断・redeploy を挟んで別プロセスが後続 phase を完了するケース) では、
   * 行を最終確定させたビルドを表す `CrawlAccountRun.appVersion` と一致しないことがあるため、
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
  blocksSynced: boolean
  warnings: CrawlWarning[]
  errorMessage: string | null
  /**
   * crawler image に埋め込まれた APPLICATION_VERSION。値が取れない場合は "unknown"。
   * 行を最終確定させたビルドを表す。個々の warning は `CrawlWarning.appVersion` を見る。
   */
  appVersion: string
  classificationStatus: string
}

export const CRAWL_ACCOUNT_CHECKPOINT_PHASES = [
  'timelines',
  'replies',
  'authors',
  'following',
  'followers',
  'blocks',
] as const

export type CrawlAccountCheckpointPhase = (typeof CRAWL_ACCOUNT_CHECKPOINT_PHASES)[number]

export interface CrawlAccountCheckpointParams {
  crawlRunId: string
  username: string
  phase: CrawlAccountCheckpointPhase
  data: Prisma.InputJsonValue
}

/** アカウントの最新試行の status と classificationStatus。 */
export interface LatestAccountStatus {
  status: string
  classificationStatus: string
}

/**
 * 再開する crawl run と、アカウントごとの最新試行の status。
 */
export interface CrawlRunStartResult {
  id: string
  latestAccountStatuses: Map<string, LatestAccountStatus>
}

/**
 * アカウント処理が進む限り定期的に呼び出す必要がある。
 * 放置判定 (startOrResumeCrawlRun) がこの値を基準にするため。
 * @param prisma - Prisma クライアント
 * @param id - 対象の CrawlRun ID
 * @param at - 記録する時刻
 * @param staleThresholdMs - 放置判定のしきい値 (ミリ秒)。staleAfterAt の算出に使う
 */
export async function touchCrawlRunHeartbeat(
  prisma: PrismaClient,
  id: string,
  at: Date,
  staleThresholdMs: number,
): Promise<void> {
  await prisma.crawlRun.update({
    where: { id },
    data: { lastHeartbeatAt: at, staleAfterAt: new Date(at.getTime() + staleThresholdMs) },
  })
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
  await prisma.$transaction(async (tx) => {
    await tx.crawlRun.update({
      where: { id },
      data: { finishedAt, status, currentUsername: null, currentAccountStartedAt: null },
    })
    // failed で終わった run でも、途中まで取得できたデータの指標更新には価値があるため
    // 常に enqueue する。完全性の記録は label_aggregate_refresh 側の責務とする。
    await enqueueWorkItem(tx, {
      kind: 'label_aggregate_refresh',
      triggerType: 'crawl_run',
      triggerId: id,
    })
  })
}

/**
 * 次のアカウントの処理開始や {@link finishCrawlRun} がこのフィールドを上書き・クリアする。
 * そのため呼び出し側で明示的なクリア処理は不要。
 * @param prisma - Prisma クライアント
 * @param crawlRunId - 対象の CrawlRun ID
 * @param username - 処理を開始したアカウントの username
 * @param startedAt - そのアカウントの処理を開始した時刻
 */
export async function setCurrentAccount(
  prisma: PrismaClient,
  crawlRunId: string,
  username: string,
  startedAt: Date,
): Promise<void> {
  await prisma.crawlRun.update({
    where: { id: crawlRunId },
    data: { currentUsername: username, currentAccountStartedAt: startedAt },
  })
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

export type CrawlAuthorCheckpointStatus = 'success' | 'unavailable' | 'failed'

export interface CrawlAuthorCheckpointParams {
  crawlRunId: string
  username: string
  authorId: string
  status: CrawlAuthorCheckpointStatus
  profileCount: number
  labelsAppliedCount: number
  warnings: CrawlWarning[]
  durationMs?: number
  retryWaitMs?: number
  appVersion: string
}

export interface CrawlAuthorCheckpointRecord {
  status: CrawlAuthorCheckpointStatus
  profileCount: number
  labelsAppliedCount: number
  warnings: CrawlWarning[]
}

/**
 * 同じ author を再度処理しても既存行を置き換えるだけで別行を作らない。
 * 自前で transaction を開かないため、呼び出し元が `tx as unknown as PrismaClient` を渡せば、
 * 外側の transaction に合成できる。
 * @param prisma - Prisma クライアント (または transaction client)
 * @param params - author checkpoint の識別子と記録内容
 */
export async function recordCrawlAuthorCheckpoint(
  prisma: PrismaClient,
  params: CrawlAuthorCheckpointParams,
): Promise<void> {
  const { crawlRunId, username, authorId, ...rest } = params
  const data = { ...rest, warnings: rest.warnings as unknown as Prisma.InputJsonValue }
  await prisma.crawlAuthorCheckpoint.upsert({
    where: { crawlRunId_username_authorId: { crawlRunId, username, authorId } },
    create: { crawlRunId, username, authorId, ...data },
    update: { ...data, completedAt: new Date() },
  })
}

/**
 * @param prisma - Prisma クライアント
 * @param crawlRunId - 取得対象の crawl run
 * @param username - 設定済みのログインアカウント
 * @returns author ID ごとの完了済み checkpoint
 */
export async function loadCrawlAuthorCheckpoints(
  prisma: PrismaClient,
  crawlRunId: string,
  username: string,
): Promise<Map<string, CrawlAuthorCheckpointRecord>> {
  const checkpoints = await prisma.crawlAuthorCheckpoint.findMany({
    where: { crawlRunId, username },
    select: {
      authorId: true,
      status: true,
      profileCount: true,
      labelsAppliedCount: true,
      warnings: true,
    },
  })
  const knownStatuses: ReadonlySet<CrawlAuthorCheckpointStatus> = new Set([
    'success',
    'unavailable',
    'failed',
  ])
  return new Map(
    checkpoints.map((checkpoint) => [
      checkpoint.authorId,
      {
        // 想定外の値が入っていた場合、再起動時に再試行させる方が安全なため failed にフォールバックする。
        status: knownStatuses.has(checkpoint.status as CrawlAuthorCheckpointStatus)
          ? (checkpoint.status as CrawlAuthorCheckpointStatus)
          : 'failed',
        profileCount: checkpoint.profileCount,
        labelsAppliedCount: checkpoint.labelsAppliedCount,
        warnings: Array.isArray(checkpoint.warnings)
          ? (checkpoint.warnings as unknown as CrawlWarning[])
          : [],
      },
    ]),
  )
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
    prisma.crawlAuthorCheckpoint.deleteMany({ where: { crawlRunId } }),
  ])
}

/**
 * 単一の crawler プロセスだけが動作する前提で運用する: 複数プロセスの同時実行は想定しない。
 * `lastHeartbeatAt` が `staleThresholdMs` を超えて更新されていない `running` 行は、
 * 正常終了できなかったものとみなして `failed` に確定する。再開可能な run は、
 * 再開を決定した時点で heartbeat/staleAfterAt を更新して生存中であることを即時に記録する。
 * @param prisma - Prisma クライアント
 * @param startedAt - 新規 run の開始時刻
 * @param staleThresholdMs - 放置判定のしきい値 (ミリ秒)。経過時間がこれを超えれば放置とみなす
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
      await prisma.crawlRun.update({
        where: { id: existingRun.id },
        data: {
          lastHeartbeatAt: startedAt,
          staleAfterAt: new Date(startedAt.getTime() + staleThresholdMs),
        },
      })
      const accountRuns = await prisma.$queryRaw<
        { username: string; status: string; classificationStatus: string }[]
      >`
        SELECT DISTINCT ON ("username") "username", "status", "classificationStatus"
        FROM "CrawlAccountRun"
        WHERE "crawlRunId" = ${existingRun.id}
        ORDER BY "username", "startedAt" DESC, "id" DESC
      `
      const latestAccountStatuses = new Map(
        accountRuns.map(({ username, status, classificationStatus }) => [
          username,
          { status, classificationStatus },
        ]),
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
    data: {
      startedAt,
      lastHeartbeatAt: startedAt,
      status: 'running',
      staleAfterAt: new Date(startedAt.getTime() + staleThresholdMs),
    },
  })
  return { id: run.id, latestAccountStatuses: new Map() }
}
