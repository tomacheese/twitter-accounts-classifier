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
import { withTwitterRetry } from './twitter/retry'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { upsertAccount, type AccountProfileInput } from './db/account-repository'
import { upsertTweets, type TweetInput } from './db/tweet-repository'
import { ensureLabelDefinitionsForRules, recordCrawlAccountLabel } from './db/label-repository'
import { loadReplyCorpus } from './db/reply-corpus'
import { LabelRuleRegistry } from './labels/registry'
import { ALL_LABEL_RULES } from './labels/all-rules'
import { buildDuplicateReplyIndex } from './labels/duplicate-reply-index'
import { buildReplyHijackIndex, type ReplyHijackCorpusEntry } from './labels/reply-hijack-index'
import { createCookieIssuerClient, type IssuedCookies } from './auth/cookie-issuer-client'
import { getLastResponseMatching } from './twitter/response-capture'
import {
  formatResponseErrorDiagnostics,
  getResponseErrorDiagnostics,
  isResponseError,
  toSafeResponseErrorForLog,
} from './twitter/response-diagnostics'
import {
  createOpenApiClient as createRealOpenApiClient,
  closeOpenApiClient as closeRealOpenApiClient,
  createTrendsScraper as createRealTrendsScraper,
  closeTrendsScraper as closeRealTrendsScraper,
} from './twitter/client'
import {
  fetchRecommendedTimeline,
  fetchFollowingTimeline,
  fetchTrendingTimeline,
  createTweetApiLike,
  type TweetApiLike,
  type TrendsScraperLike,
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
import { fetchBlocks, type BlockListApiLike, type BlockListResult } from './twitter/blocks'
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
  type CrawlAccountCheckpointParams,
  type CrawlAccountCheckpointPhase,
  type CrawlRunStartResult,
  type RecordCrawlAccountRunParams,
  type CrawlWarning,
  type CrawlWarningType,
} from './db/crawl-run-repository'
import { mergeTweetAdFlags, toAccountProfileInput } from './twitter/mappers'

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
  persistLabel: (params: {
    crawlRunId: string
    username: string
    accountId: string
    labelDefinitionId: string
    method: string
    ruleVersion: string
    result: { value: boolean; confidence: number; reason: string }
  }) => Promise<void>
  syncFollowing: (followerId: string, result: FollowListResult) => Promise<void>
  syncFollowers: (followeeId: string, result: FollowListResult) => Promise<void>
  syncBlocks: (blockerId: string, result: BlockListResult) => Promise<void>
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

function retryOptions(deps: CrawlDependencies): {
  maxAttempts: number
  delayMs: number
  sleepImpl: (ms: number) => Promise<void>
} {
  return { ...TWITTER_RETRY, sleepImpl: deps.sleep }
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

async function fetchTimelineSnapshot(
  deps: CrawlDependencies,
  account: AppConfig['accounts'][number],
  trendsContext: { scraper: TrendsScraperLike },
  client: CrawlOpenApiClient,
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
      retryOptions(deps),
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
      retryOptions(deps),
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
      retryOptions(deps),
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

async function runAccountCycleBody(
  deps: CrawlDependencies,
  registry: LabelRuleRegistry,
  labelDefinitionIds: Map<string, string>,
  duplicateReplyIndex: ReturnType<typeof buildDuplicateReplyIndex>,
  replyHijackIndex: ReturnType<typeof buildReplyHijackIndex>,
  account: AppConfig['accounts'][number],
  crawlRunId: string,
  timelineSnapshot: TimelineSnapshot,
  client: CrawlOpenApiClient,
): Promise<AccountCycleMetrics> {
  const tweetApi = client.getTweetApi()
  const userApi = client.getUserApi()

  const { recommended, following, trending } = timelineSnapshot
  const warnings = [...timelineSnapshot.warnings]

  const allTweets = [...recommended.tweets, ...following.tweets, ...trending.tweets]
  const topTweets = sortByEngagement(allTweets).slice(0, deps.limits.topTweetsForReplies)

  // Tweet.accountId は Account への必須外部キーであるため、
  // 専用のプロフィール取得が行われないか失敗した投稿者についても、
  // 埋め込みプロフィールをフォールバックとして必ず upsert する。
  const extraAuthors = new Map<string, AccountProfileInput>()
  for (const author of [...recommended.authors, ...following.authors, ...trending.authors]) {
    extraAuthors.set(author.id, author)
  }
  const replyTweets: TweetInput[] = []
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
      retryOptions(deps),
    )
    replyTweets.push(...authorReplies, ...otherReplies)
    for (const reply of otherReplies) {
      replyHijackCandidateIds.add(reply.accountId)
      const existing = otherRepliesByAuthor.get(reply.accountId) ?? []
      existing.push(reply)
      otherRepliesByAuthor.set(reply.accountId, existing)
    }
    for (const author of authors) extraAuthors.set(author.id, author)
  }

  const uniqueAuthorIds = [
    ...new Set([...allTweets.map((t) => t.accountId), ...replyHijackCandidateIds]),
  ]
  const profileTweets: TweetInput[] = []
  const succeededAuthorIds = new Set<string>()
  let labelsAppliedCount = 0

  for (const [authorIndex, authorId] of uniqueAuthorIds.entries()) {
    // 最初のアカウントの前は待つ対象がないため、sleep はスキップする。
    if (authorIndex > 0) {
      await deps.sleep(deps.limits.authorFetchDelayMs)
    }
    try {
      const profile = await withTwitterRetry(
        () => fetchAccountProfile(userApi, authorId),
        retryOptions(deps),
      )
      await deps.persistAccount(profile)
      succeededAuthorIds.add(authorId)

      const { tweets: recentTweets, authors } = await guardTimelineFetch(() =>
        withTwitterRetry(
          () => fetchRecentTweets(userApi, authorId, deps.limits.recentTweetsPerAccount),
          retryOptions(deps),
        ),
      )
      profileTweets.push(...recentTweets)
      for (const author of authors) extraAuthors.set(author.id, author)

      const authorTimelineTweets = allTweets.filter((t) => t.accountId === authorId)
      // profileTweets は他者に帰属する会話スレッドの文脈ツイートもそのまま保持するが、
      // ラベル評価用のバンドルには含めない。
      // 混入すると authorId 向けの全ルールが誤った recentTweets を読むことになるため。
      const authorOwnRecentTweets = recentTweets.filter((t) => t.accountId === authorId)
      const authorOtherReplies = otherRepliesByAuthor.get(authorId) ?? []
      const bundleTweets = mergeTweetAdFlags([
        ...authorTimelineTweets,
        ...authorOwnRecentTweets,
        ...authorOtherReplies,
      ])

      // 複数の異なるテンプレ返信ネットワークに属することがあるため、
      // 合計や平均ではなく最大値を最も強いシグナルとして採用する。
      let templatedReplyNetworkSize = 0
      for (const t of bundleTweets) {
        if (!t.isReply) continue
        templatedReplyNetworkSize = Math.max(
          templatedReplyNetworkSize,
          duplicateReplyIndex.countOtherAccounts(t.fullText, profile.id),
        )
      }

      let replyHijackSwarmSize = 0
      for (const t of bundleTweets) {
        if (!t.isReply || t.inReplyToTweetId === null) continue
        replyHijackSwarmSize = Math.max(
          replyHijackSwarmSize,
          replyHijackIndex.swarmSizeFor(profile.id, t.inReplyToTweetId),
        )
      }

      const bundle = {
        account: {
          id: profile.id,
          screenName: profile.screenName,
          displayName: profile.displayName,
          bio: profile.bio,
          followersCount: profile.followersCount,
          followingCount: profile.followingCount,
          tweetCount: profile.tweetCount,
          accountCreatedAt: profile.accountCreatedAt,
          isBlueVerified: profile.isBlueVerified,
          verifiedType: profile.verifiedType,
          professionalType: profile.professionalType,
          parodyCommentaryFanLabel: profile.parodyCommentaryFanLabel,
        },
        recentTweets: bundleTweets.map((t) => ({
          id: t.id,
          fullText: t.fullText,
          createdAt: t.createdAt,
          retweetCount: t.retweetCount,
          likeCount: t.likeCount,
          isReply: t.isReply,
          isRetweet: t.isRetweet,
          isPromoted: t.isPromoted,
          isPaidPromotion: t.isPaidPromotion,
          hasAiGeneratedMedia: t.hasAiGeneratedMedia,
          aiGeneratedDetectionSource: t.aiGeneratedDetectionSource,
          foreignVideoSourceCount: t.foreignVideoSourceCount,
          inReplyToTweetId: t.inReplyToTweetId,
          quotedTweetAuthorId: t.quotedTweetAuthorId,
          quotedTweetHasVideo: t.quotedTweetHasVideo,
        })),
        templatedReplyNetworkSize,
        replyHijackSwarmSize,
      }

      for (const { rule, result } of registry.applyAll(bundle)) {
        const labelDefinitionId = labelDefinitionIds.get(rule.key)
        if (!labelDefinitionId) {
          logger.warn(`No LabelDefinition id found for rule "${rule.key}", skipping persistence`)
          continue
        }
        await deps.persistLabel({
          crawlRunId,
          username: account.username,
          accountId: profile.id,
          labelDefinitionId,
          method: rule.key,
          ruleVersion: rule.version,
          result,
        })
        labelsAppliedCount++
      }
    } catch (error) {
      if (isExpectedAccountLookupError(error)) {
        logger.info(
          `Skipping author ${authorId}: account is unavailable (suspended, deleted, or protected)`,
        )
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
        warnings.push({
          type: 'author_processing_failed',
          message,
          authorId,
          errorMessage: toErrorMessage(error),
          ...diagnostics,
          appVersion: APP_VERSION,
        })
      }
    }
  }

  for (const [id, profile] of extraAuthors) {
    if (succeededAuthorIds.has(id)) continue
    await deps.persistAccount(profile)
  }

  await deps.persistTweets(mergeTweetAdFlags([...allTweets, ...replyTweets, ...profileTweets]))
  logger.info(
    `Crawl cycle complete for ${account.username}: ${allTweets.length} timeline tweets, ${replyTweets.length} replies, ${uniqueAuthorIds.length} profiles`,
  )
  return {
    recommendedCount: recommended.tweets.length,
    followingCount: following.tweets.length,
    trendingCount: trending.tweets.length,
    replyCount: replyTweets.length,
    profileCount: succeededAuthorIds.size,
    labelsAppliedCount,
    warnings,
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
): Promise<FollowingCheckpointData> {
  let userId: string
  try {
    const response = await withTwitterRetry(
      () => client.getUserApi().getUserByScreenName({ screenName: account.username }),
      retryOptions(deps),
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
      retryOptions(deps),
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
): Promise<FollowersCheckpointData> {
  if (!userId) return { synced: false, warnings: [] }
  try {
    const followers = await withTwitterRetry(
      () => fetchFollowers(client.getUserListApi(), userId, deps.limits.followEdgesPerAccount),
      retryOptions(deps),
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
): Promise<BlocksCheckpointData> {
  if (!blockerId) return { synced: false, warnings: [] }
  try {
    const blocks = await withTwitterRetry(
      () => fetchBlocks(client.getBlocksApi(), deps.limits.blockEdgesPerAccount),
      retryOptions(deps),
    )
    await deps.syncBlocks(blockerId, blocks)
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
  account: AppConfig['accounts'][number],
  crawlRunId: string,
): Promise<'success' | 'partial'> {
  const startedAt = new Date()
  await deps.setCurrentAccount(crawlRunId, account.username, startedAt)
  try {
    const checkpoints = await deps.loadCrawlAccountCheckpoints(crawlRunId, account.username)
    let timelineSnapshot = restoreTimelineSnapshot(checkpoints.get('timelines'))
    let metrics = restoreAccountCycleMetrics(checkpoints.get('authors'))
    let following = restoreFollowingCheckpoint(checkpoints.get('following'))
    let followers = restoreFollowersCheckpoint(checkpoints.get('followers'))
    let blocks = restoreBlocksCheckpoint(checkpoints.get('blocks'))
    const needsTimeline = !metrics && !timelineSnapshot
    const needsAuthors = !metrics
    const needsFollowing = !following
    const needsFollowers = !followers
    const needsBlocks = !blocks

    if (needsTimeline || needsAuthors || needsFollowing || needsFollowers || needsBlocks) {
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
            timelineSnapshot = await fetchTimelineSnapshot(
              deps,
              account,
              trendsContext,
              openApiContext.client,
            )
            await deps.completeCrawlAccountCheckpoint({
              crawlRunId,
              username: account.username,
              phase: 'timelines',
              data: toCheckpointData(storeTimelineSnapshot(timelineSnapshot)),
            })
          }
          if (needsAuthors) {
            if (!timelineSnapshot) throw new Error('Missing timeline checkpoint for author phase')
            metrics = await runAccountCycleBody(
              deps,
              registry,
              labelDefinitionIds,
              duplicateReplyIndex,
              replyHijackIndex,
              account,
              crawlRunId,
              timelineSnapshot,
              openApiContext.client,
            )
            await deps.completeCrawlAccountCheckpoint({
              crawlRunId,
              username: account.username,
              phase: 'authors',
              data: toCheckpointData(metrics),
            })
          }
          if (needsFollowing) {
            following = await syncFollowingPhase(deps, account, openApiContext.client)
            await deps.completeCrawlAccountCheckpoint({
              crawlRunId,
              username: account.username,
              phase: 'following',
              data: toCheckpointData(following),
            })
          }
          if (needsFollowers) {
            followers = await syncFollowersPhase(
              deps,
              account,
              openApiContext.client,
              following?.userId ?? null,
            )
            await deps.completeCrawlAccountCheckpoint({
              crawlRunId,
              username: account.username,
              phase: 'followers',
              data: toCheckpointData(followers),
            })
          }
          if (needsBlocks) {
            blocks = await syncBlocksPhase(
              deps,
              account,
              openApiContext.client,
              following?.userId ?? null,
            )
            await deps.completeCrawlAccountCheckpoint({
              crawlRunId,
              username: account.username,
              phase: 'blocks',
              data: toCheckpointData(blocks),
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
    })
    throw error
  }
}

export async function runCrawlCycle(deps: CrawlDependencies): Promise<void> {
  const registry = new LabelRuleRegistry()
  for (const rule of ALL_LABEL_RULES) registry.register(rule)
  const labelDefinitionIds = await deps.ensureLabelDefinitions(registry)
  // テンプレ返信ネットワークの検出はアカウント横断の比較が本質のため、
  // アカウントごとではなくサイクルごとに 1 回だけ構築する。
  const replyCorpus = await deps.loadReplyCorpus()
  const duplicateReplyIndex = buildDuplicateReplyIndex(replyCorpus)
  const replyHijackIndex = buildReplyHijackIndex(replyCorpus)

  const { id: crawlRunId, latestAccountStatuses } = await deps.startOrResumeCrawlRun(new Date())

  // ここから下を try で囲む: 捕捉しないと CrawlRun が 'running' のまま残ってしまうため、
  // 必ず 'failed' として確定させる。ただしプロセスの強制終了と、
  // この確定処理自体の失敗の 2 つは検知できない。
  try {
    const accountStatuses: ('success' | 'partial' | 'failed')[] = []

    for (const account of deps.config.accounts) {
      const previousStatus = latestAccountStatuses.get(account.username)
      if (previousStatus === 'success' || previousStatus === 'partial') {
        accountStatuses.push(previousStatus)
        continue
      }

      try {
        const status = await runAccountCycle(
          deps,
          registry,
          labelDefinitionIds,
          duplicateReplyIndex,
          replyHijackIndex,
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
 * @param blocksClient - `OpenApiClientContext` のラップ済み `BlockListApiLike` blocks クライアント
 * @returns {@link runCrawlCycle} で使用できる `CrawlOpenApiClient`
 */
function toCrawlOpenApiClient(
  realClient: Awaited<ReturnType<typeof createRealOpenApiClient>>['client'],
  blocksClient: BlockListApiLike,
): CrawlOpenApiClient {
  return {
    getTweetApi: () => ({
      ...createTweetApiLike(realClient.getTweetApi()),
      ...createTweetDetailApiLike(realClient.getTweetApi()),
    }),
    getUserApi: () => createUserApiLike(realClient.getUserApi(), realClient.getTweetApi()),
    getUserListApi: () => createFollowListApiLike(realClient.getUserListApi()),
    getBlocksApi: () => blocksClient,
  }
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
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
    persistAccount: async (input) => {
      await upsertAccount(prisma, input)
    },
    persistTweets: async (inputs) => {
      await upsertTweets(prisma, inputs)
    },
    ensureLabelDefinitions: (registry) => ensureLabelDefinitionsForRules(prisma, registry.getAll()),
    loadReplyCorpus: () => loadReplyCorpus(prisma),
    persistLabel: async (params) => {
      await recordCrawlAccountLabel(prisma, params)
    },
    syncFollowing: (followerId, result) => syncFollowingEdges(prisma, followerId, result),
    syncFollowers: (followeeId, result) => syncFollowersEdges(prisma, followeeId, result),
    syncBlocks: (blockerId, result) => syncBlocksEdges(prisma, blockerId, result),
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
      touchCrawlRunHeartbeatRecord(prisma, crawlRunId, new Date()),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }

  try {
    await runCrawlCycle(deps)
  } finally {
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
