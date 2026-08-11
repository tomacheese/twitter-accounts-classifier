import { Logger } from '@book000/node-utils'
import { captureException, captureMessage, initMonitoring } from './monitoring/sentry'
import { loadConfig, type AppConfig } from './config/load-config'
import { CRAWL_LIMITS, TWITTER_RETRY } from './config/crawl-limits'
import {
  getCookieIssuerBaseUrl,
  getCrawlIntervalSeconds,
  getCrawlStaleThresholdMultiplier,
  getCrawlWarningThreshold,
} from './config/env'
import type { PrismaClient } from './generated/prisma'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { upsertComponentBuildIdentity } from './build-identity'
import { upsertAccount, type AccountProfileInput } from './db/account-repository'
import { upsertTweets, type TweetInput } from './db/tweet-repository'
import {
  ensureLabelDefinitionsForRules,
  filterAccountIdsWithExistingLabels,
} from './db/label-repository'
import { refreshLabelAggregate } from './db/label-aggregate-repository'
import {
  requestAccountRelabel,
  requestAccountRelabelBulk,
} from './db/analysis-work-item-repository'
import { loadReplyCorpus } from './db/reply-corpus'
import { LabelRuleRegistry } from './labels/registry'
import { ALL_LABEL_RULES } from './labels/all-rules'
import { buildDuplicateReplyIndex } from './labels/duplicate-reply-index'
import { buildReplyHijackIndex, type ReplyHijackCorpusEntry } from './labels/reply-hijack-index'
import {
  buildFollowGraphLabelIndex,
  type FollowGraphLabelIndex,
} from './labels/follow-graph-label-index'
import {
  createCookieIssuerClient,
  formatResponseErrorDiagnostics,
  getLastResponseMatching,
  getResponseErrorDiagnostics,
  isResponseError,
  toSafeResponseErrorForLog,
  withTwitterRetry,
  mergeTweetAdFlags,
  toAccountProfileInput,
  createOpenApiClient as createRealOpenApiClient,
  closeOpenApiClient as closeRealOpenApiClient,
  createTrendsScraper as createRealTrendsScraper,
  closeTrendsScraper as closeRealTrendsScraper,
  type IssuedCookies,
  type TrendsScraperLike,
  type BlocksListRawApiLike,
} from 'twitter-client'
import {
  fetchRecommendedTimeline,
  fetchFollowingTimeline,
  fetchTrendingTimeline,
  createTweetApiLike,
  type TweetApiLike,
} from './twitter/timeline'
import {
  sortByEngagement,
  fetchReplies,
  createTweetDetailApiLike,
  type TweetDetailApiLike,
} from './twitter/engagement'
import {
  fetchAccountProfile,
  fetchRecentTweets,
  createUserApiLike,
  type UserApiLike,
} from './twitter/profile'
import {
  createFollowListApiLike,
  fetchFollowers,
  fetchFollowing,
  type FollowListApiLike,
  type FollowListResult,
} from './twitter/follows'
import {
  syncFollowers as syncFollowersEdges,
  syncFollowing as syncFollowingEdges,
} from './db/follow-repository'
import {
  persistAuthorResultAtomic as persistAuthorResultAtomicRecord,
  type PersistAuthorResultAtomicParams,
  type PersistAuthorResultAtomicResult,
} from './db/author-checkpoint-repository'
import {
  fetchBlocks,
  createBlockListApiLike,
  type BlockListApiLike,
  type BlockListResult,
} from './twitter/blocks'
import { syncBlocks as syncBlocksEdges } from './db/block-repository'
import {
  clearCrawlAccountCheckpoints as clearCrawlAccountCheckpointsRecord,
  completeCrawlAccountCheckpoint as completeCrawlAccountCheckpointRecord,
  loadCrawlAccountCheckpoints as loadCrawlAccountCheckpointsRecord,
  startOrResumeCrawlRun as startOrResumeCrawlRunRecord,
  touchCrawlRunHeartbeat as touchCrawlRunHeartbeatRecord,
  finishCrawlRun as finishCrawlRunRecord,
  recordCrawlAccountRun as recordCrawlAccountRunRecord,
  setCurrentAccount as setCurrentAccountRecord,
  recordCrawlAuthorCheckpoint as recordCrawlAuthorCheckpointRecord,
  loadCrawlAuthorCheckpoints as loadCrawlAuthorCheckpointsRecord,
  type CrawlAccountCheckpointParams,
  type CrawlAccountCheckpointPhase,
  type CrawlAuthorCheckpointParams,
  type CrawlAuthorCheckpointRecord,
  type CrawlRunStartResult,
  type RecordCrawlAccountRunParams,
  type CrawlWarning,
  type CrawlWarningType,
} from './db/crawl-run-repository'

const logger = Logger.configure('crawl')

const APP_VERSION = process.env.APPLICATION_VERSION ?? 'unknown'

export interface CrawlOpenApiClient {
  getTweetApi(): TweetApiLike & TweetDetailApiLike
  getUserApi(): UserApiLike
  getUserListApi(): FollowListApiLike
  getBlocksApi(): BlockListApiLike
}

export interface CrawlDependencies {
  config: AppConfig
  limits: typeof CRAWL_LIMITS
  issueCookies: (account: {
    username: string
    password: string
    otp_secret: string | null
  }) => Promise<IssuedCookies>
  createOpenApiClient: (cookies: IssuedCookies) => Promise<{ client: CrawlOpenApiClient }>
  closeOpenApiClient: (context: { client: CrawlOpenApiClient }) => Promise<void>
  createTrendsScraper: (cookies: IssuedCookies) => Promise<{ scraper: TrendsScraperLike }>
  closeTrendsScraper: (context: { scraper: TrendsScraperLike }) => Promise<void>
  persistAccount: (input: AccountProfileInput) => Promise<void>
  persistTweets: (inputs: TweetInput[]) => Promise<void>
  ensureLabelDefinitions: (registry: LabelRuleRegistry) => Promise<Map<string, string>>
  loadReplyCorpus: () => Promise<ReplyHijackCorpusEntry[]>
  loadFollowGraphLabelIndex: (
    labelDefinitionIds: Map<string, string>,
  ) => Promise<FollowGraphLabelIndex>
  persistAuthorResultAtomic: (
    params: PersistAuthorResultAtomicParams,
  ) => Promise<PersistAuthorResultAtomicResult>
  recordCrawlAuthorCheckpoint: (params: CrawlAuthorCheckpointParams) => Promise<void>
  loadCrawlAuthorCheckpoints: (
    crawlRunId: string,
    username: string,
  ) => Promise<Map<string, CrawlAuthorCheckpointRecord>>
  syncFollowing: (followerId: string, result: FollowListResult) => Promise<void>
  syncFollowers: (followeeId: string, result: FollowListResult) => Promise<void>
  syncBlocks: (blockerId: string, crawlRunId: string, result: BlockListResult) => Promise<void>
  startOrResumeCrawlRun: (startedAt: Date) => Promise<CrawlRunStartResult>
  finishCrawlRun: (id: string, finishedAt: Date, status: string) => Promise<void>
  setCurrentAccount: (crawlRunId: string, username: string, startedAt: Date) => Promise<void>
  recordCrawlAccountRun: (params: RecordCrawlAccountRunParams) => Promise<void>
  loadCrawlAccountCheckpoints: (
    crawlRunId: string,
    username: string,
  ) => Promise<Map<CrawlAccountCheckpointPhase, unknown>>
  completeCrawlAccountCheckpoint: (params: CrawlAccountCheckpointParams) => Promise<void>
  clearCrawlAccountCheckpoints: (crawlRunId: string) => Promise<void>
  /**
   * checkpoint で skip したアカウントでは呼ばない: 放置判定の基準となる生存時刻を、
   * 実際に処理を試みたアカウントの分だけ進めるため。
   */
  touchCrawlRunHeartbeat: (crawlRunId: string) => Promise<void>
  /** テスト時に `withTwitterRetry` のバックオフや author ループの待機を無効化する注入。 */
  sleep: (ms: number) => Promise<void>
}

/**
 * 呼び出し元の待機時間累積用アキュムレータへ加算しつつ、
 * 上位 phase 全体の trackRetryWait へも転送する tracker を作る。
 * @param trackRetryWait - phase 全体の待機時間を集計する tracker
 * @param accumulator - この呼び出し元 (例: author 単位) の待機時間だけを集計するアキュムレータ
 * @returns retryOptions に渡せる tracker 関数
 */
function createScopedRetryWaitTracker(
  trackRetryWait: (ms: number) => void,
  accumulator: { ms: number },
): (ms: number) => void {
  return (ms) => {
    accumulator.ms += ms
    trackRetryWait(ms)
  }
}

function retryOptions(
  deps: CrawlDependencies,
  trackRetryWait: (ms: number) => void,
): {
  maxAttempts: number
  delayMs: number
  sleepImpl: (ms: number) => Promise<void>
} {
  return {
    ...TWITTER_RETRY,
    sleepImpl: async (ms) => {
      trackRetryWait(ms)
      await deps.sleep(ms)
    },
  }
}

/** measurePhaseDuration の結果。 */
export interface PhaseDurationResult<T> {
  value: T
  durationMs: number
  retryWaitMs: number
}

/**
 * 待機時間を実処理時間に含めると、rate limit 由来の待ちを phase 自体の遅さと誤認するため、`trackRetryWait` で呼び出し元が明示的に切り出す。
 * @param fn - 計測対象の非同期処理。`trackRetryWait` で retry 待機時間を加算できる
 * @returns 処理結果と、実処理時間・retry 待機時間 (ミリ秒)
 */
export async function measurePhaseDuration<T>(
  fn: (trackRetryWait: (ms: number) => void) => Promise<T>,
): Promise<PhaseDurationResult<T>> {
  let retryWaitMs = 0
  const start = Date.now()
  const value = await fn((ms) => {
    retryWaitMs += ms
  })
  return { value, durationMs: Date.now() - start, retryWaitMs }
}

/**
 * 呼び出し箇所ごとに個別にラップする: per-author 処理全体で TypeError を捕捉すると、
 * この既知のライブラリ不具合以外の TypeError まで誤って対象にしてしまうため。
 */
class TimelineUnavailableError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'TimelineUnavailableError'
  }
}

/**
 * `twitter-openapi-typescript` は `e.data.user?.result.timeline.timeline` の
 * オプショナルチェイニングが `data.user` しか保護しておらず、`result.timeline` が
 * 欠けている場合に型付きエラーではなく素の TypeError を投げるため、
 * 型で判定できず message 文字列の一致で見分けている。
 * @param fetch - ガード対象の `fetchRecentTweets` 呼び出し
 * @returns 呼び出し結果。既知のライブラリ不具合の場合は `TimelineUnavailableError` を rethrow する
 */
async function guardTimelineFetch<T>(fetch: () => Promise<T>): Promise<T> {
  try {
    return await fetch()
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("reading 'timeline'")) {
      throw new TimelineUnavailableError(error)
    }
    throw error
  }
}

/**
 * 想定内のアカウント利用不可 (凍結・削除・鍵アカウント化) は warning に含めない。
 * 日常的に発生するものまで数えると、本当に調査すべき警告が埋もれてしまうため。
 * @param error - 1 アカウントの処理中に捕捉したエラー
 * @returns 想定内のアカウント利用不可であれば true
 */
function isExpectedAccountLookupError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message === 'User not found') return true
  if (error.name === 'ResponseError') {
    const status = (error as { response?: { status?: unknown } }).response?.status
    return status === 404
  }
  return error instanceof TimelineUnavailableError
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 個々の警告の詳細は CrawlAccountRun.warnings に既に保存済みのため、
 * GlitchTip へ送るサマリーには種類ごとの件数のみを含め、ペイロードを膨らませない。
 * @param warnings - 1 アカウントサイクル分の警告
 * @returns 警告種類ごとの件数。0 件の種類は含まない
 */
function summarizeWarningsByType(
  warnings: CrawlWarning[],
): Partial<Record<CrawlWarningType, number>> {
  const counts: Partial<Record<CrawlWarningType, number>> = {}
  for (const warning of warnings) {
    counts[warning.type] = (counts[warning.type] ?? 0) + 1
  }
  return counts
}

const LABELING_INPUT_WARNING_TYPES = new Set<CrawlWarningType>([
  'recommended_timeline_failed',
  'following_timeline_failed',
  'trending_timeline_failed',
  'author_processing_failed',
])

/**
 * ログインアカウント 1 サイクル分の classification component 状態を導出する。
 * @param input - 例外の有無・skip の有無・記録された warning 一覧
 * @returns success/partial/failed/skipped のいずれか
 */
export function deriveClassificationStatus(input: {
  warnings: { type: CrawlWarningType }[]
  wasSkipped: boolean
  wasCaughtException: boolean
}): string {
  if (input.wasCaughtException) return 'failed'
  if (input.wasSkipped) return 'skipped'
  const hasLabelingInputWarning = input.warnings.some((warning) =>
    LABELING_INPUT_WARNING_TYPES.has(warning.type),
  )
  return hasLabelingInputWarning ? 'partial' : 'success'
}

interface AccountCycleMetrics {
  recommendedCount: number
  followingCount: number
  trendingCount: number
  replyCount: number
  profileCount: number
  labelsAppliedCount: number
  warnings: CrawlWarning[]
}

interface TimelineSnapshot {
  recommended: { tweets: TweetInput[]; authors: AccountProfileInput[] }
  following: { tweets: TweetInput[]; authors: AccountProfileInput[] }
  trending: { tweets: TweetInput[]; authors: AccountProfileInput[] }
  warnings: CrawlWarning[]
}

interface RepliesResult {
  replyTweets: TweetInput[]
  replyAuthors: AccountProfileInput[]
  replyHijackCandidateIds: string[]
  /** author 単位の判定入力に必要な、reply-hijack 候補として検出した返信そのもの。 */
  otherRepliesByAuthor: Record<string, TweetInput[]>
  warnings: CrawlWarning[]
}

async function fetchTimelineSnapshot(
  deps: CrawlDependencies,
  account: AppConfig['accounts'][number],
  trendsContext: { scraper: TrendsScraperLike },
  client: CrawlOpenApiClient,
  trackRetryWait: (ms: number) => void,
): Promise<TimelineSnapshot> {
  const tweetApi = client.getTweetApi()
  const warnings: CrawlWarning[] = []
  const emptyTimeline: { tweets: TweetInput[]; authors: AccountProfileInput[] } = {
    tweets: [],
    authors: [],
  }
  const [recommended, following, trending] = await Promise.all([
    withTwitterRetry(
      () => fetchRecommendedTimeline(tweetApi, deps.limits.tweetsPerTimeline),
      retryOptions(deps, trackRetryWait),
    ).catch((error: unknown) => {
      const message = `Recommended timeline fetch failed for ${account.username}, continuing without it`
      logger.error(message, error as Error)
      warnings.push({
        type: 'recommended_timeline_failed',
        message,
        username: account.username,
        errorMessage: toErrorMessage(error),
        rawResponseSnippet: getLastResponseMatching('HomeTimeline')?.body,
        appVersion: APP_VERSION,
      })
      return emptyTimeline
    }),
    withTwitterRetry(
      () => fetchFollowingTimeline(tweetApi, deps.limits.tweetsPerTimeline),
      retryOptions(deps, trackRetryWait),
    ).catch((error: unknown) => {
      const message = `Following timeline fetch failed for ${account.username}, continuing without it`
      logger.error(message, error as Error)
      warnings.push({
        type: 'following_timeline_failed',
        message,
        username: account.username,
        errorMessage: toErrorMessage(error),
        rawResponseSnippet: getLastResponseMatching('HomeLatestTimeline')?.body,
        appVersion: APP_VERSION,
      })
      return emptyTimeline
    }),
    withTwitterRetry(
      () =>
        fetchTrendingTimeline(
          trendsContext.scraper,
          tweetApi,
          deps.limits.tweetsPerTimeline,
          deps.limits.trendsPerCycle,
        ),
      retryOptions(deps, trackRetryWait),
    ).catch((error: unknown) => {
      const message = `Trending timeline fetch failed for ${account.username}, continuing without it`
      logger.error(message, error as Error)
      warnings.push({
        type: 'trending_timeline_failed',
        message,
        username: account.username,
        errorMessage: toErrorMessage(error),
        rawResponseSnippet: getLastResponseMatching('SearchTimeline')?.body,
        appVersion: APP_VERSION,
      })
      return emptyTimeline
    }),
  ])
  return { recommended, following, trending, warnings }
}

async function runRepliesPhase(
  deps: CrawlDependencies,
  timelineSnapshot: TimelineSnapshot,
  client: CrawlOpenApiClient,
  trackRetryWait: (ms: number) => void,
): Promise<RepliesResult> {
  const tweetApi = client.getTweetApi()
  const { recommended, following, trending } = timelineSnapshot
  const allTweets = [...recommended.tweets, ...following.tweets, ...trending.tweets]
  const topTweets = sortByEngagement(allTweets).slice(0, deps.limits.topTweetsForReplies)

  const replyTweets: TweetInput[] = []
  const replyAuthors = new Map<string, AccountProfileInput>()
  // ラベル評価ループをタイムライン投稿者だけに絞ると、
  // 自分ではバズる投稿をしない reply-hijack 系アカウントを一切評価できなくなるため、
  // 候補として別途集める。
  const replyHijackCandidateIds = new Set<string>()
  // 候補を検出した実際の返信そのものを保持しないと、
  // ラベル評価は候補者について別途取得した投稿履歴だけに頼ることになり、
  // 判定の根拠となった返信自体が失われてしまう。
  const otherRepliesByAuthor = new Map<string, TweetInput[]>()
  for (const topTweet of topTweets) {
    const { authorReplies, otherReplies, authors } = await withTwitterRetry(
      () => fetchReplies(tweetApi, topTweet, deps.limits.repliesPerTweet),
      retryOptions(deps, trackRetryWait),
    )
    replyTweets.push(...authorReplies, ...otherReplies)
    for (const reply of otherReplies) {
      replyHijackCandidateIds.add(reply.accountId)
      const existing = otherRepliesByAuthor.get(reply.accountId) ?? []
      existing.push(reply)
      otherRepliesByAuthor.set(reply.accountId, existing)
    }
    for (const author of authors) replyAuthors.set(author.id, author)
  }

  return {
    replyTweets,
    replyAuthors: [...replyAuthors.values()],
    replyHijackCandidateIds: [...replyHijackCandidateIds],
    otherRepliesByAuthor: Object.fromEntries(otherRepliesByAuthor),
    warnings: [],
  }
}

async function runAuthorUnitPhase(
  deps: CrawlDependencies,
  registry: LabelRuleRegistry,
  labelDefinitionIds: Map<string, string>,
  duplicateReplyIndex: ReturnType<typeof buildDuplicateReplyIndex>,
  replyHijackIndex: ReturnType<typeof buildReplyHijackIndex>,
  followGraphLabelIndex: FollowGraphLabelIndex,
  account: AppConfig['accounts'][number],
  crawlRunId: string,
  timelineSnapshot: TimelineSnapshot,
  repliesResult: RepliesResult,
  client: CrawlOpenApiClient,
  trackRetryWait: (ms: number) => void,
): Promise<AccountCycleMetrics> {
  const userApi = client.getUserApi()
  const { recommended, following, trending } = timelineSnapshot

  // Tweet.accountId は Account への必須外部キーであるため、
  // 専用のプロフィール取得が行われないか失敗した投稿者についても、
  // 埋め込みプロフィールをフォールバックとして必ず upsert する。
  // 文脈 Tweet の fallback profile は persistAuthorResultAtomic 側で扱うため、ここには含めない。
  const extraAuthors = new Map<string, AccountProfileInput>()
  for (const author of [
    ...recommended.authors,
    ...following.authors,
    ...trending.authors,
    ...repliesResult.replyAuthors,
  ]) {
    extraAuthors.set(author.id, author)
  }
  const otherRepliesByAuthor = new Map(Object.entries(repliesResult.otherRepliesByAuthor))
  const allTweets = [...recommended.tweets, ...following.tweets, ...trending.tweets]
  const uniqueAuthorIds = [
    ...new Set([...allTweets.map((t) => t.accountId), ...repliesResult.replyHijackCandidateIds]),
  ]

  const existingCheckpoints = await deps.loadCrawlAuthorCheckpoints(crawlRunId, account.username)
  const warnings: CrawlWarning[] = []
  const succeededAuthorIds = new Set<string>()
  let labelsAppliedCount = 0
  // 集計を再起動回数に依存させないため、前回までの checkpoint 分をまず合算する。
  for (const [authorId, checkpoint] of existingCheckpoints) {
    if (checkpoint.status === 'success') succeededAuthorIds.add(authorId)
    labelsAppliedCount += checkpoint.labelsAppliedCount
    warnings.push(...checkpoint.warnings)
  }

  for (const [authorIndex, authorId] of uniqueAuthorIds.entries()) {
    const existingCheckpoint = existingCheckpoints.get(authorId)
    // failed は一時的な障害に起因することがあるため、再起動を跨いだ再試行を許す。
    // success・unavailable は永続的な終了状態として skip する。
    if (existingCheckpoint && existingCheckpoint.status !== 'failed') continue
    // 最初のアカウントの前は待つ対象がないため、sleep はスキップする。
    if (authorIndex > 0) {
      await deps.sleep(deps.limits.authorFetchDelayMs)
    }

    const authorStartedAt = Date.now()
    const authorRetryWait = { ms: 0 }
    const trackAuthorRetryWait = createScopedRetryWaitTracker(trackRetryWait, authorRetryWait)
    const authorWarnings: CrawlWarning[] = []

    try {
      const profile = await withTwitterRetry(
        () => fetchAccountProfile(userApi, authorId),
        retryOptions(deps, trackAuthorRetryWait),
      )

      const { tweets: recentTweets, authors: fallbackAuthors } = await guardTimelineFetch(() =>
        withTwitterRetry(
          () => fetchRecentTweets(userApi, authorId, deps.limits.recentTweetsPerAccount),
          retryOptions(deps, trackAuthorRetryWait),
        ),
      )

      // フォロー先サンプルの取得はラベリング精度を補強する追加シグナルに過ぎないため、
      // 失敗してもキーワードベースのラベリングまで止めない。
      let followSample: FollowListResult | null = null
      try {
        followSample = await withTwitterRetry(
          () =>
            fetchFollowing(
              client.getUserListApi(),
              authorId,
              deps.limits.followEdgesPerLabeledAccount,
            ),
          retryOptions(deps, trackAuthorRetryWait),
        )
      } catch (error) {
        const message = `Failed to fetch labeling follow sample for author ${authorId}, continuing without it`
        logger.error(message, error as Error)
        authorWarnings.push({
          type: 'labeling_follow_sample_failed',
          message,
          authorId,
          errorMessage: toErrorMessage(error),
          appVersion: APP_VERSION,
        })
      }

      const authorTimelineTweets = allTweets.filter((t) => t.accountId === authorId)
      const authorOtherReplies = otherRepliesByAuthor.get(authorId) ?? []

      const { observationId, labelsAppliedCount: appliedThisAuthor } =
        await deps.persistAuthorResultAtomic({
          crawlRunId,
          username: account.username,
          authorId,
          profile,
          recentTweets,
          additionalOwnTweets: [...authorTimelineTweets, ...authorOtherReplies],
          recentTweetsFallbackAuthors: fallbackAuthors,
          followSample,
          registry,
          labelDefinitionIds,
          duplicateReplyIndex,
          replyHijackIndex,
          followGraphLabelIndex,
          warnings: authorWarnings,
          durationMs: Date.now() - authorStartedAt,
          retryWaitMs: authorRetryWait.ms,
          appVersion: APP_VERSION,
        })
      succeededAuthorIds.add(authorId)
      // 再試行時は ON CONFLICT DO NOTHING で何も claim できず null が返る。
      // 実際には何も永続化していないため、件数を二重に数えない。
      if (observationId !== null) labelsAppliedCount += appliedThisAuthor
      warnings.push(...authorWarnings)
    } catch (error) {
      if (isExpectedAccountLookupError(error)) {
        logger.info(
          `Skipping author ${authorId}: account is unavailable (suspended, deleted, or protected)`,
        )
        // checkpoint 書き込み自体の失敗で phase 全体を止めない。失敗しても次回の resume でこの author が再試行されるだけである。
        try {
          await deps.recordCrawlAuthorCheckpoint({
            crawlRunId,
            username: account.username,
            authorId,
            status: 'unavailable',
            profileCount: 0,
            labelsAppliedCount: 0,
            warnings: authorWarnings,
            durationMs: Date.now() - authorStartedAt,
            retryWaitMs: authorRetryWait.ms,
            appVersion: APP_VERSION,
          })
        } catch (checkpointError) {
          logger.error(
            `Failed to record author checkpoint for ${authorId}`,
            checkpointError as Error,
          )
        }
        warnings.push(...authorWarnings)
      } else {
        const diagnostics = getResponseErrorDiagnostics(error)
        const message = diagnostics
          ? `Failed to process author ${authorId}, skipping to next author (${formatResponseErrorDiagnostics(diagnostics)})`
          : `Failed to process author ${authorId}, skipping to next author`
        if (isResponseError(error)) {
          logger.error(message, toSafeResponseErrorForLog(error))
        } else {
          logger.error(message, error as Error)
        }
        const warning: CrawlWarning = {
          type: 'author_processing_failed',
          message,
          authorId,
          errorMessage: toErrorMessage(error),
          ...diagnostics,
          appVersion: APP_VERSION,
        }
        try {
          await deps.recordCrawlAuthorCheckpoint({
            crawlRunId,
            username: account.username,
            authorId,
            status: 'failed',
            profileCount: 0,
            labelsAppliedCount: 0,
            warnings: [...authorWarnings, warning],
            durationMs: Date.now() - authorStartedAt,
            retryWaitMs: authorRetryWait.ms,
            appVersion: APP_VERSION,
          })
        } catch (checkpointError) {
          logger.error(
            `Failed to record author checkpoint for ${authorId}`,
            checkpointError as Error,
          )
        }
        warnings.push(...authorWarnings, warning)
      }
    }

    // author 単位の checkpoint 完了ごとに更新する: 1 author が長時間かかっても、
    // その間に CrawlRun が stale と誤判定されないようにするため。
    try {
      await deps.touchCrawlRunHeartbeat(crawlRunId)
    } catch (error) {
      logger.error(`Failed to update heartbeat for crawl run ${crawlRunId}`, error as Error)
    }
  }

  for (const [id, profile] of extraAuthors) {
    if (succeededAuthorIds.has(id)) continue
    await deps.persistAccount(profile)
  }

  // author 単位の transaction 内でも同じ id の Tweet を書き込むことがあるが、
  // upsertTweet は既存 DB 行との OR 結合で isPromoted 等を合成するため、
  // 書き込み順に関わらず最終的に正しい値へ収束する。
  await deps.persistTweets(mergeTweetAdFlags([...allTweets, ...repliesResult.replyTweets]))
  logger.info(
    `Crawl cycle complete for ${account.username}: ${allTweets.length} timeline tweets, ${repliesResult.replyTweets.length} replies, ${uniqueAuthorIds.length} profiles`,
  )
  return {
    recommendedCount: recommended.tweets.length,
    followingCount: following.tweets.length,
    trendingCount: trending.tweets.length,
    replyCount: repliesResult.replyTweets.length,
    profileCount: succeededAuthorIds.size,
    labelsAppliedCount,
    warnings: [...timelineSnapshot.warnings, ...repliesResult.warnings, ...warnings],
  }
}

interface FollowingCheckpointData {
  userId: string | null
  synced: boolean
  warnings: CrawlWarning[]
}

interface FollowersCheckpointData {
  synced: boolean
  warnings: CrawlWarning[]
}

async function syncFollowingPhase(
  deps: CrawlDependencies,
  account: AppConfig['accounts'][number],
  client: CrawlOpenApiClient,
  trackRetryWait: (ms: number) => void,
): Promise<FollowingCheckpointData> {
  let userId: string
  try {
    const response = await withTwitterRetry(
      () => client.getUserApi().getUserByScreenName({ screenName: account.username }),
      retryOptions(deps, trackRetryWait),
    )
    userId = response.data.restId
    // Follow テーブルの followerId/followeeId は Account への必須外部キーであり、
    // このログインアカウントは今回のサイクル中に投稿者として現れるとは限らないため、
    // ここで自身の Account 行を upsert しないと以降の edge upsert が失敗する。
    await deps.persistAccount(toAccountProfileInput(response.data))
  } catch (error) {
    const message = `Failed to resolve or persist own account for ${account.username}, skipping follow/follower sync`
    logger.error(message, error as Error)
    return {
      userId: null,
      synced: false,
      warnings: [
        {
          type: 'own_account_sync_failed',
          message,
          username: account.username,
          errorMessage: toErrorMessage(error),
          appVersion: APP_VERSION,
        },
      ],
    }
  }

  try {
    const following = await withTwitterRetry(
      () => fetchFollowing(client.getUserListApi(), userId, deps.limits.followEdgesPerAccount),
      retryOptions(deps, trackRetryWait),
    )
    await deps.syncFollowing(userId, following)
    return { userId, synced: true, warnings: [] }
  } catch (error) {
    const message = `Failed to sync following for ${account.username}`
    logger.error(message, error as Error)
    return {
      userId,
      synced: false,
      warnings: [
        {
          type: 'following_sync_failed',
          message,
          username: account.username,
          errorMessage: toErrorMessage(error),
          appVersion: APP_VERSION,
        },
      ],
    }
  }
}

async function syncFollowersPhase(
  deps: CrawlDependencies,
  account: AppConfig['accounts'][number],
  client: CrawlOpenApiClient,
  userId: string | null,
  trackRetryWait: (ms: number) => void,
): Promise<FollowersCheckpointData> {
  if (!userId) return { synced: false, warnings: [] }
  try {
    const followers = await withTwitterRetry(
      () => fetchFollowers(client.getUserListApi(), userId, deps.limits.followEdgesPerAccount),
      retryOptions(deps, trackRetryWait),
    )
    await deps.syncFollowers(userId, followers)
    return { synced: true, warnings: [] }
  } catch (error) {
    const message = `Failed to sync followers for ${account.username}`
    logger.error(message, error as Error)
    return {
      synced: false,
      warnings: [
        {
          type: 'followers_sync_failed',
          message,
          username: account.username,
          errorMessage: toErrorMessage(error),
          appVersion: APP_VERSION,
        },
      ],
    }
  }
}

async function syncBlocksPhase(
  deps: CrawlDependencies,
  account: AppConfig['accounts'][number],
  client: CrawlOpenApiClient,
  blockerId: string | null,
  crawlRunId: string,
  trackRetryWait: (ms: number) => void,
): Promise<BlocksCheckpointData> {
  if (!blockerId) return { synced: false, warnings: [] }
  try {
    const blocks = await withTwitterRetry(
      () => fetchBlocks(client.getBlocksApi(), deps.limits.blockEdgesPerAccount),
      retryOptions(deps, trackRetryWait),
    )
    await deps.syncBlocks(blockerId, crawlRunId, blocks)
    return { synced: true, warnings: [] }
  } catch (error) {
    const message = `Failed to sync blocked users for ${account.username}`
    logger.error(message, error as Error)
    return {
      synced: false,
      warnings: [
        {
          type: 'blocks_sync_failed',
          message,
          username: account.username,
          errorMessage: toErrorMessage(error),
          rawResponseSnippet: getLastResponseMatching('BlockedAccountsAll')?.body,
          appVersion: APP_VERSION,
        },
      ],
    }
  }
}

type StoredTweetInput = Omit<TweetInput, 'createdAt'> & { createdAt: string }
type StoredAccountProfileInput = Omit<AccountProfileInput, 'accountCreatedAt'> & {
  accountCreatedAt: string
}

interface StoredTimelineResult {
  tweets: StoredTweetInput[]
  authors: StoredAccountProfileInput[]
}

interface StoredTimelineSnapshot {
  recommended: StoredTimelineResult
  following: StoredTimelineResult
  trending: StoredTimelineResult
  warnings: CrawlWarning[]
}

function toCheckpointData(value: unknown): CrawlAccountCheckpointParams['data'] {
  const serialized = JSON.stringify(value)
  if (!serialized) throw new Error('Cannot serialize an empty crawl checkpoint')
  return JSON.parse(serialized) as CrawlAccountCheckpointParams['data']
}

function storeTimelineResult(result: {
  tweets: TweetInput[]
  authors: AccountProfileInput[]
}): StoredTimelineResult {
  return {
    tweets: result.tweets.map(({ createdAt, ...tweet }) => ({
      ...tweet,
      createdAt: createdAt.toISOString(),
    })),
    authors: result.authors.map(({ accountCreatedAt, ...author }) => ({
      ...author,
      accountCreatedAt: accountCreatedAt.toISOString(),
    })),
  }
}

function storeTimelineSnapshot(snapshot: TimelineSnapshot): StoredTimelineSnapshot {
  return {
    recommended: storeTimelineResult(snapshot.recommended),
    following: storeTimelineResult(snapshot.following),
    trending: storeTimelineResult(snapshot.trending),
    warnings: snapshot.warnings,
  }
}

interface StoredRepliesResult {
  replyTweets: StoredTweetInput[]
  replyAuthors: StoredAccountProfileInput[]
  replyHijackCandidateIds: string[]
  otherRepliesByAuthor: Record<string, StoredTweetInput[]>
  warnings: CrawlWarning[]
}

function storeTweetInputs(tweets: TweetInput[]): StoredTweetInput[] {
  return tweets.map(({ createdAt, ...tweet }) => ({ ...tweet, createdAt: createdAt.toISOString() }))
}

function storeRepliesResult(result: RepliesResult): StoredRepliesResult {
  return {
    replyTweets: storeTweetInputs(result.replyTweets),
    replyAuthors: result.replyAuthors.map(({ accountCreatedAt, ...author }) => ({
      ...author,
      accountCreatedAt: accountCreatedAt.toISOString(),
    })),
    replyHijackCandidateIds: result.replyHijackCandidateIds,
    otherRepliesByAuthor: Object.fromEntries(
      Object.entries(result.otherRepliesByAuthor).map(([authorId, tweets]) => [
        authorId,
        storeTweetInputs(tweets),
      ]),
    ),
    warnings: result.warnings,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function restoreDate(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || isNullableString(value)
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function isCrawlWarning(value: unknown): value is CrawlWarning {
  if (!isRecord(value)) return false
  if (
    ![
      'recommended_timeline_failed',
      'following_timeline_failed',
      'trending_timeline_failed',
      'author_processing_failed',
      'own_account_sync_failed',
      'following_sync_failed',
      'followers_sync_failed',
      'blocks_sync_failed',
      'labeling_follow_sample_failed',
    ].includes(value.type as string)
  ) {
    return false
  }
  return (
    typeof value.message === 'string' &&
    typeof value.errorMessage === 'string' &&
    (value.username === undefined || typeof value.username === 'string') &&
    (value.authorId === undefined || typeof value.authorId === 'string') &&
    (value.rawResponseSnippet === undefined || typeof value.rawResponseSnippet === 'string') &&
    (value.appVersion === undefined || typeof value.appVersion === 'string')
  )
}

function restoreWarnings(value: unknown): CrawlWarning[] | undefined {
  if (!Array.isArray(value) || !value.every((warning) => isCrawlWarning(warning))) return undefined
  return value
}

function isStoredTweetInput(value: Record<string, unknown>): value is StoredTweetInput {
  return (
    typeof value.id === 'string' &&
    typeof value.accountId === 'string' &&
    typeof value.fullText === 'string' &&
    restoreDate(value.createdAt) !== undefined &&
    isFiniteNumber(value.retweetCount) &&
    isFiniteNumber(value.likeCount) &&
    isFiniteNumber(value.replyCount) &&
    isFiniteNumber(value.quoteCount) &&
    typeof value.isReply === 'boolean' &&
    isNullableString(value.inReplyToTweetId) &&
    typeof value.isAuthorReply === 'boolean' &&
    typeof value.isRetweet === 'boolean' &&
    isNullableString(value.retweetedTweetId) &&
    typeof value.isPromoted === 'boolean' &&
    typeof value.isPaidPromotion === 'boolean' &&
    isNullableBoolean(value.hasAiGeneratedMedia) &&
    isNullableString(value.aiGeneratedDetectionSource) &&
    isNullableString(value.quotedTweetId) &&
    isNullableString(value.quotedTweetAuthorId) &&
    isNullableBoolean(value.quotedTweetHasVideo) &&
    ['recommended', 'following', 'trending', 'profile', 'manual'].includes(value.source as string)
  )
}

function isStoredAccountProfileInput(
  value: Record<string, unknown>,
): value is StoredAccountProfileInput {
  return (
    typeof value.id === 'string' &&
    typeof value.screenName === 'string' &&
    typeof value.displayName === 'string' &&
    isNullableString(value.bio) &&
    isNullableString(value.profileImageUrl) &&
    isFiniteNumber(value.followersCount) &&
    isFiniteNumber(value.followingCount) &&
    isFiniteNumber(value.tweetCount) &&
    restoreDate(value.accountCreatedAt) !== undefined &&
    isNullableString(value.location) &&
    isNullableString(value.url) &&
    typeof value.isBlueVerified === 'boolean' &&
    isNullableString(value.verifiedType) &&
    isOptionalNullableString(value.professionalType) &&
    isOptionalNullableString(value.parodyCommentaryFanLabel)
  )
}

function restoreTimelineResult(value: unknown):
  | {
      tweets: TweetInput[]
      authors: AccountProfileInput[]
    }
  | undefined {
  if (!isRecord(value) || !Array.isArray(value.tweets) || !Array.isArray(value.authors)) {
    return undefined
  }
  const tweets: TweetInput[] = []
  for (const value_ of value.tweets) {
    if (!isRecord(value_) || !isStoredTweetInput(value_)) return undefined
    const createdAt = restoreDate(value_.createdAt)
    if (!createdAt) return undefined
    tweets.push({ ...value_, createdAt })
  }
  const authors: AccountProfileInput[] = []
  for (const value_ of value.authors) {
    if (!isRecord(value_) || !isStoredAccountProfileInput(value_)) return undefined
    const accountCreatedAt = restoreDate(value_.accountCreatedAt)
    if (!accountCreatedAt) return undefined
    authors.push({ ...value_, accountCreatedAt })
  }
  return { tweets, authors }
}

function restoreTimelineSnapshot(value: unknown): TimelineSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const warnings = restoreWarnings(value.warnings)
  if (!warnings) return undefined
  const recommended = restoreTimelineResult(value.recommended)
  const following = restoreTimelineResult(value.following)
  const trending = restoreTimelineResult(value.trending)
  if (!recommended || !following || !trending) return undefined
  return {
    recommended,
    following,
    trending,
    warnings,
  }
}

function restoreTweetInputs(value: unknown): TweetInput[] | undefined {
  if (!Array.isArray(value)) return undefined
  const tweets: TweetInput[] = []
  for (const value_ of value) {
    if (!isRecord(value_) || !isStoredTweetInput(value_)) return undefined
    const createdAt = restoreDate(value_.createdAt)
    if (!createdAt) return undefined
    tweets.push({ ...value_, createdAt })
  }
  return tweets
}

function restoreRepliesResult(value: unknown): RepliesResult | undefined {
  if (!isRecord(value)) return undefined
  const warnings = restoreWarnings(value.warnings)
  if (!warnings) return undefined
  const replyTweets = restoreTweetInputs(value.replyTweets)
  if (!replyTweets) return undefined
  if (!Array.isArray(value.replyAuthors)) return undefined
  const replyAuthors: AccountProfileInput[] = []
  for (const value_ of value.replyAuthors) {
    if (!isRecord(value_) || !isStoredAccountProfileInput(value_)) return undefined
    const accountCreatedAt = restoreDate(value_.accountCreatedAt)
    if (!accountCreatedAt) return undefined
    replyAuthors.push({ ...value_, accountCreatedAt })
  }
  if (
    !Array.isArray(value.replyHijackCandidateIds) ||
    !value.replyHijackCandidateIds.every((id) => typeof id === 'string')
  ) {
    return undefined
  }
  if (!isRecord(value.otherRepliesByAuthor)) return undefined
  const otherRepliesByAuthor: Record<string, TweetInput[]> = {}
  for (const [authorId, tweets] of Object.entries(value.otherRepliesByAuthor)) {
    const restoredTweets = restoreTweetInputs(tweets)
    if (!restoredTweets) return undefined
    otherRepliesByAuthor[authorId] = restoredTweets
  }
  return {
    replyTweets,
    replyAuthors,
    replyHijackCandidateIds: value.replyHijackCandidateIds,
    otherRepliesByAuthor,
    warnings,
  }
}

function restoreAccountCycleMetrics(value: unknown): AccountCycleMetrics | undefined {
  if (!isRecord(value)) return undefined
  const warnings = restoreWarnings(value.warnings)
  if (!warnings) return undefined
  const metricKeys: (keyof Omit<AccountCycleMetrics, 'warnings'>)[] = [
    'recommendedCount',
    'followingCount',
    'trendingCount',
    'replyCount',
    'profileCount',
    'labelsAppliedCount',
  ]
  if (metricKeys.some((key) => typeof value[key] !== 'number')) return undefined
  return {
    recommendedCount: value.recommendedCount as number,
    followingCount: value.followingCount as number,
    trendingCount: value.trendingCount as number,
    replyCount: value.replyCount as number,
    profileCount: value.profileCount as number,
    labelsAppliedCount: value.labelsAppliedCount as number,
    warnings,
  }
}

function restoreFollowingCheckpoint(value: unknown): FollowingCheckpointData | undefined {
  if (!isRecord(value) || typeof value.synced !== 'boolean') {
    return undefined
  }
  const warnings = restoreWarnings(value.warnings)
  if (!warnings) return undefined
  if (value.userId !== null && typeof value.userId !== 'string') return undefined
  return {
    userId: value.userId,
    synced: value.synced,
    warnings,
  }
}

function restoreFollowersCheckpoint(value: unknown): FollowersCheckpointData | undefined {
  if (!isRecord(value) || typeof value.synced !== 'boolean') {
    return undefined
  }
  const warnings = restoreWarnings(value.warnings)
  if (!warnings) return undefined
  return { synced: value.synced, warnings }
}

interface BlocksCheckpointData {
  synced: boolean
  warnings: CrawlWarning[]
}

function restoreBlocksCheckpoint(value: unknown): BlocksCheckpointData | undefined {
  if (!isRecord(value) || typeof value.synced !== 'boolean') {
    return undefined
  }
  const warnings = restoreWarnings(value.warnings)
  if (!warnings) return undefined
  return { synced: value.synced, warnings }
}

async function runAccountCycle(
  deps: CrawlDependencies,
  registry: LabelRuleRegistry,
  labelDefinitionIds: Map<string, string>,
  duplicateReplyIndex: ReturnType<typeof buildDuplicateReplyIndex>,
  replyHijackIndex: ReturnType<typeof buildReplyHijackIndex>,
  followGraphLabelIndex: FollowGraphLabelIndex,
  account: AppConfig['accounts'][number],
  crawlRunId: string,
): Promise<'success' | 'partial'> {
  const startedAt = new Date()
  // 進捗表示用の書き込みが失敗してもアカウントのクロール自体は継続する:
  // 実クロール結果を記録する recordCrawlAccountRun とは異なり、
  // このフィールドは表示専用で欠落してもクロールの正しさに影響しないため。
  try {
    await deps.setCurrentAccount(crawlRunId, account.username, startedAt)
  } catch (error) {
    logger.error(`Failed to record current account for crawl run ${crawlRunId}`, error as Error)
  }
  try {
    const checkpoints = await deps.loadCrawlAccountCheckpoints(crawlRunId, account.username)
    let timelineSnapshot = restoreTimelineSnapshot(checkpoints.get('timelines'))
    let repliesResult = restoreRepliesResult(checkpoints.get('replies'))
    let metrics = restoreAccountCycleMetrics(checkpoints.get('authors'))
    let following = restoreFollowingCheckpoint(checkpoints.get('following'))
    let followers = restoreFollowersCheckpoint(checkpoints.get('followers'))
    let blocks = restoreBlocksCheckpoint(checkpoints.get('blocks'))
    const needsTimeline = !metrics && !timelineSnapshot
    const needsReplies = !metrics && !repliesResult
    const needsAuthors = !metrics
    const needsFollowing = !following
    const needsFollowers = !followers
    const needsBlocks = !blocks

    if (
      needsTimeline ||
      needsReplies ||
      needsAuthors ||
      needsFollowing ||
      needsFollowers ||
      needsBlocks
    ) {
      const cookies = await deps.issueCookies({
        username: account.username,
        password: account.password,
        otp_secret: account.otpSecret,
      })
      const trendsContext = needsTimeline ? await deps.createTrendsScraper(cookies) : undefined
      try {
        const openApiContext = await deps.createOpenApiClient(cookies)
        try {
          if (needsTimeline) {
            if (!trendsContext) throw new Error('Missing trends context for timeline checkpoint')
            const timelinePhase = await measurePhaseDuration((trackRetryWait) =>
              fetchTimelineSnapshot(
                deps,
                account,
                trendsContext,
                openApiContext.client,
                trackRetryWait,
              ),
            )
            timelineSnapshot = timelinePhase.value
            await deps.completeCrawlAccountCheckpoint({
              crawlRunId,
              username: account.username,
              phase: 'timelines',
              data: toCheckpointData({
                ...storeTimelineSnapshot(timelineSnapshot),
                durationMs: timelinePhase.durationMs,
                retryWaitMs: timelinePhase.retryWaitMs,
              }),
            })
          }
          if (needsReplies) {
            if (!timelineSnapshot) throw new Error('Missing timeline checkpoint for replies phase')
            const resolvedTimelineSnapshotForReplies = timelineSnapshot
            const repliesPhase = await measurePhaseDuration((trackRetryWait) =>
              runRepliesPhase(
                deps,
                resolvedTimelineSnapshotForReplies,
                openApiContext.client,
                trackRetryWait,
              ),
            )
            repliesResult = repliesPhase.value
            await deps.completeCrawlAccountCheckpoint({
              crawlRunId,
              username: account.username,
              phase: 'replies',
              data: toCheckpointData({
                ...storeRepliesResult(repliesResult),
                durationMs: repliesPhase.durationMs,
                retryWaitMs: repliesPhase.retryWaitMs,
              }),
            })
          }
          if (needsAuthors) {
            if (!timelineSnapshot) throw new Error('Missing timeline checkpoint for author phase')
            if (!repliesResult) throw new Error('Missing replies checkpoint for author phase')
            const resolvedTimelineSnapshot = timelineSnapshot
            const resolvedRepliesResult = repliesResult
            const authorsPhase = await measurePhaseDuration((trackRetryWait) =>
              runAuthorUnitPhase(
                deps,
                registry,
                labelDefinitionIds,
                duplicateReplyIndex,
                replyHijackIndex,
                followGraphLabelIndex,
                account,
                crawlRunId,
                resolvedTimelineSnapshot,
                resolvedRepliesResult,
                openApiContext.client,
                trackRetryWait,
              ),
            )
            metrics = authorsPhase.value
            await deps.completeCrawlAccountCheckpoint({
              crawlRunId,
              username: account.username,
              phase: 'authors',
              data: toCheckpointData({
                ...metrics,
                durationMs: authorsPhase.durationMs,
                retryWaitMs: authorsPhase.retryWaitMs,
              }),
            })
          }
          if (needsFollowing) {
            const followingPhase = await measurePhaseDuration((trackRetryWait) =>
              syncFollowingPhase(deps, account, openApiContext.client, trackRetryWait),
            )
            following = followingPhase.value
            await deps.completeCrawlAccountCheckpoint({
              crawlRunId,
              username: account.username,
              phase: 'following',
              data: toCheckpointData({
                ...following,
                durationMs: followingPhase.durationMs,
                retryWaitMs: followingPhase.retryWaitMs,
              }),
            })
          }
          if (needsFollowers) {
            const followersPhase = await measurePhaseDuration((trackRetryWait) =>
              syncFollowersPhase(
                deps,
                account,
                openApiContext.client,
                following?.userId ?? null,
                trackRetryWait,
              ),
            )
            followers = followersPhase.value
            await deps.completeCrawlAccountCheckpoint({
              crawlRunId,
              username: account.username,
              phase: 'followers',
              data: toCheckpointData({
                ...followers,
                durationMs: followersPhase.durationMs,
                retryWaitMs: followersPhase.retryWaitMs,
              }),
            })
          }
          if (needsBlocks) {
            const blocksPhase = await measurePhaseDuration((trackRetryWait) =>
              syncBlocksPhase(
                deps,
                account,
                openApiContext.client,
                following?.userId ?? null,
                crawlRunId,
                trackRetryWait,
              ),
            )
            blocks = blocksPhase.value
            await deps.completeCrawlAccountCheckpoint({
              crawlRunId,
              username: account.username,
              phase: 'blocks',
              data: toCheckpointData({
                ...blocks,
                durationMs: blocksPhase.durationMs,
                retryWaitMs: blocksPhase.retryWaitMs,
              }),
            })
          }
        } finally {
          await deps.closeOpenApiClient(openApiContext)
        }
      } finally {
        if (trendsContext) await deps.closeTrendsScraper(trendsContext)
      }
    }

    if (!metrics || !following || !followers || !blocks) {
      throw new Error(`Incomplete crawl checkpoints for ${account.username}`)
    }

    // 残った warning はリトライと想定内エラーの除外を経ても解消しなかったものであるため、1 件でも 'partial' として扱う。
    const warnings = [
      ...metrics.warnings,
      ...following.warnings,
      ...followers.warnings,
      ...blocks.warnings,
    ]
    const status = warnings.length > 0 ? 'partial' : 'success'

    await deps.recordCrawlAccountRun({
      crawlRunId,
      username: account.username,
      startedAt,
      finishedAt: new Date(),
      status,
      recommendedCount: metrics.recommendedCount,
      followingCount: metrics.followingCount,
      trendingCount: metrics.trendingCount,
      replyCount: metrics.replyCount,
      profileCount: metrics.profileCount,
      labelsAppliedCount: metrics.labelsAppliedCount,
      followingSynced: following.synced,
      followersSynced: followers.synced,
      blocksSynced: blocks.synced,
      warnings,
      errorMessage: null,
      appVersion: APP_VERSION,
      classificationStatus: deriveClassificationStatus({
        warnings,
        wasSkipped: false,
        wasCaughtException: false,
      }),
    })

    // recordCrawlAccountRun の後に実行する: GlitchTip への到達性に関わらず、
    // 永続化された CrawlAccountRun には常に実際の結果を反映させるため。
    // メッセージ文言には件数を埋め込まない:埋め込むと件数ごとに別イシューへ分裂してしまい、
    // 同一アカウントの繰り返し超過を 1 つのイシューにまとめられなくなるため。
    const warningThreshold = getCrawlWarningThreshold()
    if (warnings.length >= warningThreshold) {
      captureMessage(`Crawl warnings threshold exceeded for ${account.username}`, {
        crawlRunId,
        username: account.username,
        status,
        appVersion: APP_VERSION,
        warningCount: warnings.length,
        warningThreshold,
        warningCounts: summarizeWarningsByType(warnings),
      })
    }

    return status
  } catch (error) {
    await deps.recordCrawlAccountRun({
      crawlRunId,
      username: account.username,
      startedAt,
      finishedAt: new Date(),
      status: 'failed',
      recommendedCount: 0,
      followingCount: 0,
      trendingCount: 0,
      replyCount: 0,
      profileCount: 0,
      labelsAppliedCount: 0,
      followingSynced: false,
      followersSynced: false,
      blocksSynced: false,
      warnings: [],
      errorMessage: String(error),
      appVersion: APP_VERSION,
      classificationStatus: deriveClassificationStatus({
        warnings: [],
        wasSkipped: false,
        wasCaughtException: true,
      }),
    })
    throw error
  }
}

export async function runCrawlCycle(deps: CrawlDependencies): Promise<void> {
  const registry = new LabelRuleRegistry()
  for (const rule of ALL_LABEL_RULES) registry.register(rule)
  const labelDefinitionIds = await deps.ensureLabelDefinitions(registry)
  const { id: crawlRunId, latestAccountStatuses } = await deps.startOrResumeCrawlRun(new Date())

  // CrawlRun 開始後の前処理も try に含める。前処理は本番規模では長時間かかり得るため、
  // 開始前に実行すると生存中でも古い heartbeat の CrawlRun が残って見える。また前処理が
  // 失敗した場合に running 行を確定できない。
  try {
    const followGraphLabelIndex = await deps.loadFollowGraphLabelIndex(labelDefinitionIds)
    // テンプレ返信ネットワークの検出はアカウント横断の比較が本質のため、
    // アカウントごとではなくサイクルごとに 1 回だけ構築する。
    const replyCorpus = await deps.loadReplyCorpus()
    const duplicateReplyIndex = buildDuplicateReplyIndex(replyCorpus)
    const replyHijackIndex = buildReplyHijackIndex(replyCorpus)

    const accountStatuses: ('success' | 'partial' | 'failed')[] = []

    for (const account of deps.config.accounts) {
      const previous = latestAccountStatuses.get(account.username)
      if (previous?.status === 'success' || previous?.status === 'partial') {
        accountStatuses.push(previous.status)
        // 同じ crawlRunId の再開 (コンテナ再起動等) を繰り返すたびに、既に完了した
        // Account 分の skipped 行を際限なく積み増さないよう、直近の試行が既に
        // skipped であれば書き込み自体を省略する。
        if (previous.classificationStatus !== 'skipped') {
          await deps.recordCrawlAccountRun({
            crawlRunId,
            username: account.username,
            startedAt: new Date(),
            finishedAt: new Date(),
            status: previous.status,
            recommendedCount: 0,
            followingCount: 0,
            trendingCount: 0,
            replyCount: 0,
            profileCount: 0,
            labelsAppliedCount: 0,
            followingSynced: false,
            followersSynced: false,
            blocksSynced: false,
            warnings: [],
            errorMessage: null,
            appVersion: APP_VERSION,
            classificationStatus: 'skipped',
          })
        }
        continue
      }

      try {
        const status = await runAccountCycle(
          deps,
          registry,
          labelDefinitionIds,
          duplicateReplyIndex,
          replyHijackIndex,
          followGraphLabelIndex,
          account,
          crawlRunId,
        )
        accountStatuses.push(status)
      } catch (error) {
        logger.error(
          `Crawl cycle failed for ${account.username}, skipping to next account`,
          error as Error,
        )
        accountStatuses.push('failed')
      }

      try {
        await deps.touchCrawlRunHeartbeat(crawlRunId)
      } catch (error) {
        logger.error(`Failed to update heartbeat for crawl run ${crawlRunId}`, error as Error)
      }
    }

    const runStatus = accountStatuses.includes('failed')
      ? 'failed'
      : accountStatuses.includes('partial')
        ? 'partial'
        : 'success'
    await deps.finishCrawlRun(crawlRunId, new Date(), runStatus)
    try {
      await deps.clearCrawlAccountCheckpoints(crawlRunId)
    } catch (error) {
      logger.error(
        `Failed to clear checkpoints for finalized crawl run ${crawlRunId}`,
        error as Error,
      )
    }
  } catch (error) {
    try {
      await deps.finishCrawlRun(crawlRunId, new Date(), 'failed')
    } catch (finalizeError) {
      // この二次的な失敗を優先して投げず、
      // 元の error をそのまま rethrow する: 原因の手がかりを失うほうが影響が大きく、
      // いずれにせよ行は 'running' のまま残るため。
      logger.error('Failed to finalize the CrawlRun as failed', finalizeError as Error)
    }
    throw error
  }
}

/**
 * @param realClient - 認証済みの実際の `TwitterOpenApiClient`
 * @param rawBlocksClient - `OpenApiClientContext` が返す raw な blocks クライアント
 * @returns {@link runCrawlCycle} で使用できる `CrawlOpenApiClient`
 */
function toCrawlOpenApiClient(
  realClient: Awaited<ReturnType<typeof createRealOpenApiClient>>['client'],
  rawBlocksClient: BlocksListRawApiLike,
): CrawlOpenApiClient {
  return {
    getTweetApi: () => ({
      ...createTweetApiLike(realClient.getTweetApi()),
      ...createTweetDetailApiLike(realClient.getTweetApi()),
    }),
    getUserApi: () => createUserApiLike(realClient.getUserApi(), realClient.getTweetApi()),
    getUserListApi: () => createFollowListApiLike(realClient.getUserListApi()),
    getBlocksApi: () => createBlockListApiLike(rawBlocksClient),
  }
}

/**
 * profile 更新を永続化し、classification-relevant な変化があった既存ラベル済み account のみ再評価を要求する persistAccount 実装を作る。
 * @param prisma - Prisma クライアント
 * @returns CrawlDependencies['persistAccount'] に渡せる関数
 */
export function createPersistAccountFn(prisma: PrismaClient): CrawlDependencies['persistAccount'] {
  return async (input) => {
    const { account, changed } = await upsertAccount(prisma, input, { detectChange: true })
    if (!changed) return
    const relabelable = await filterAccountIdsWithExistingLabels(prisma, [account.id])
    if (relabelable.has(account.id)) {
      await requestAccountRelabel(prisma, account.id)
    }
  }
}

/**
 * tweet 更新を永続化し、classification-relevant な変化があった既存ラベル済み account のみ再評価を要求する persistTweets 実装を作る。
 * @param prisma - Prisma クライアント
 * @returns CrawlDependencies['persistTweets'] に渡せる関数
 */
export function createPersistTweetsFn(prisma: PrismaClient): CrawlDependencies['persistTweets'] {
  return async (inputs) => {
    const results = await upsertTweets(prisma, inputs)
    const changedAccountIds = [
      ...new Set(
        results.filter((result) => result.changed).map((result) => result.tweet.accountId),
      ),
    ]
    if (changedAccountIds.length === 0) return
    const relabelable = await filterAccountIdsWithExistingLabels(prisma, changedAccountIds)
    await requestAccountRelabelBulk(prisma, [...relabelable])
  }
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  await upsertComponentBuildIdentity(prisma, 'crawler')
  const cookieIssuer = createCookieIssuerClient({
    baseUrl: getCookieIssuerBaseUrl(),
  })

  const staleThresholdMs = getCrawlIntervalSeconds() * getCrawlStaleThresholdMultiplier() * 1000

  const deps: CrawlDependencies = {
    config: loadConfig(),
    limits: CRAWL_LIMITS,
    issueCookies: (account) => cookieIssuer.issueCookiesWithRetry(account),
    createOpenApiClient: async (cookies) => {
      const context = await createRealOpenApiClient(cookies)
      return { ...context, client: toCrawlOpenApiClient(context.client, context.blocksClient) }
    },
    closeOpenApiClient: (context) =>
      closeRealOpenApiClient(context as unknown as Parameters<typeof closeRealOpenApiClient>[0]),
    createTrendsScraper: (cookies) => createRealTrendsScraper(cookies),
    closeTrendsScraper: (context) =>
      closeRealTrendsScraper(context as Parameters<typeof closeRealTrendsScraper>[0]),
    persistAccount: createPersistAccountFn(prisma),
    persistTweets: createPersistTweetsFn(prisma),
    ensureLabelDefinitions: (registry) => ensureLabelDefinitionsForRules(prisma, registry.getAll()),
    loadReplyCorpus: () => loadReplyCorpus(prisma),
    loadFollowGraphLabelIndex: (labelDefinitionIds) =>
      buildFollowGraphLabelIndex(prisma, labelDefinitionIds),
    persistAuthorResultAtomic: (params) => persistAuthorResultAtomicRecord(prisma, params),
    recordCrawlAuthorCheckpoint: (params) => recordCrawlAuthorCheckpointRecord(prisma, params),
    loadCrawlAuthorCheckpoints: (crawlRunId, username) =>
      loadCrawlAuthorCheckpointsRecord(prisma, crawlRunId, username),
    syncFollowing: (followerId, result) => syncFollowingEdges(prisma, followerId, result),
    syncFollowers: (followeeId, result) => syncFollowersEdges(prisma, followeeId, result),
    syncBlocks: (blockerId, crawlRunId, result) =>
      syncBlocksEdges(prisma, blockerId, crawlRunId, result),
    startOrResumeCrawlRun: (startedAt) =>
      startOrResumeCrawlRunRecord(prisma, startedAt, staleThresholdMs),
    finishCrawlRun: (id, finishedAt, status) =>
      finishCrawlRunRecord(prisma, id, finishedAt, status),
    setCurrentAccount: (crawlRunId, username, startedAt) =>
      setCurrentAccountRecord(prisma, crawlRunId, username, startedAt),
    recordCrawlAccountRun: (params) => recordCrawlAccountRunRecord(prisma, params),
    loadCrawlAccountCheckpoints: (crawlRunId, username) =>
      loadCrawlAccountCheckpointsRecord(prisma, crawlRunId, username),
    completeCrawlAccountCheckpoint: (params) =>
      completeCrawlAccountCheckpointRecord(prisma, params),
    clearCrawlAccountCheckpoints: (crawlRunId) =>
      clearCrawlAccountCheckpointsRecord(prisma, crawlRunId),
    touchCrawlRunHeartbeat: (crawlRunId) =>
      touchCrawlRunHeartbeatRecord(prisma, crawlRunId, new Date(), staleThresholdMs),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }

  try {
    await runCrawlCycle(deps)
  } finally {
    // runCrawlCycle はアカウント単位で逐次ラベルを書き込むため、
    // 一部で失敗しても finally で必ず集計し直す
    // (relabel.ts はバックフィル全体が未完了のまま反映すると
    // 新旧ラベルが混在した中途半端な集計を表示してしまうため、成功時のみ呼ぶ)。
    try {
      await refreshLabelAggregate(prisma)
    } catch (error) {
      logger.error('Failed to refresh label aggregate:', error as Error)
      captureException(error, { source: 'crawl.refreshLabelAggregate' })
    }
    await disconnectPrisma()
  }
}

// import.meta ではなく require/module を使う: このプロジェクトは CommonJS であり ESM ではないため。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  initMonitoring()
  main().catch((error: unknown) => {
    logger.error('Crawl cycle failed', error as Error)
    captureException(error)
    process.exitCode = 1
  })
}
