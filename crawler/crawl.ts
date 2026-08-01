import { Logger } from '@book000/node-utils'
import { captureException, initMonitoring } from './monitoring/sentry'
import { loadConfig, type AppConfig } from './config/load-config'
import { CRAWL_LIMITS, TWITTER_RETRY } from './config/crawl-limits'
import { getCookieIssuerBaseUrl } from './config/env'
import { withTwitterRetry } from './twitter/retry'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { upsertAccount, type AccountProfileInput } from './db/account-repository'
import { upsertTweets, type TweetInput } from './db/tweet-repository'
import { ensureLabelDefinitionsForRules, recordAccountLabel } from './db/label-repository'
import { loadReplyCorpus } from './db/reply-corpus'
import { LabelRuleRegistry } from './labels/registry'
import { ALL_LABEL_RULES } from './labels/all-rules'
import { buildDuplicateReplyIndex } from './labels/duplicate-reply-index'
import { buildReplyHijackIndex, type ReplyHijackCorpusEntry } from './labels/reply-hijack-index'
import { createCookieIssuerClient, type IssuedCookies } from './auth/cookie-issuer-client'
import { getLastResponseMatching } from './twitter/response-capture'
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
import {
  startCrawlRun as startCrawlRunRecord,
  finishCrawlRun as finishCrawlRunRecord,
  recordCrawlAccountRun as recordCrawlAccountRunRecord,
  type RecordCrawlAccountRunParams,
  type CrawlWarning,
} from './db/crawl-run-repository'
import { mergeTweetAdFlags, toAccountProfileInput } from './twitter/mappers'

const logger = Logger.configure('crawl')

export interface CrawlOpenApiClient {
  getTweetApi(): TweetApiLike & TweetDetailApiLike
  getUserApi(): UserApiLike
  getUserListApi(): FollowListApiLike
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
    accountId: string
    labelDefinitionId: string
    method: string
    ruleVersion: string
    result: { value: boolean; confidence: number; reason: string }
  }) => Promise<void>
  syncFollowing: (followerId: string, result: FollowListResult) => Promise<void>
  syncFollowers: (followeeId: string, result: FollowListResult) => Promise<void>
  startCrawlRun: (startedAt: Date) => Promise<{ id: string }>
  finishCrawlRun: (id: string, finishedAt: Date, status: string) => Promise<void>
  recordCrawlAccountRun: (params: RecordCrawlAccountRunParams) => Promise<void>
  /** Injectable so `withTwitterRetry`'s backoff and the author-loop throttle don't actually pause tests. */
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
 * Distinguishes an author lookup failure that is an expected, routine occurrence — the
 * account was suspended, deleted, or made protected between being seen as a tweet author
 * and this loop reaching it — from a genuine infrastructure failure. Expected failures are
 * logged but excluded from `warnings`: counting them would make almost every crawl cycle
 * "partial" purely because Twitter accounts churn, drowning out warnings that actually
 * indicate a problem worth investigating.
 * @param error - the error thrown while processing one author
 * @returns true if this failure is a routine account-lookup miss, not an infra problem
 */
function isExpectedAccountLookupError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.message === 'User not found') return true
  if (error.name === 'ResponseError') {
    const status = (error as { response?: { status?: unknown } }).response?.status
    return status === 404
  }
  return false
}

/**
 * Extracts a warning-safe message from a caught value.
 * @param error - the caught value, typically from a `catch (error)` block
 * @returns an `Error`'s `message`, or a stringified fallback for anything else thrown
 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

async function runAccountCycleBody(
  deps: CrawlDependencies,
  registry: LabelRuleRegistry,
  labelDefinitionIds: Map<string, string>,
  duplicateReplyIndex: ReturnType<typeof buildDuplicateReplyIndex>,
  replyHijackIndex: ReturnType<typeof buildReplyHijackIndex>,
  account: AppConfig['accounts'][number],
  trendsContext: { scraper: TrendsScraperLike },
  client: CrawlOpenApiClient,
): Promise<AccountCycleMetrics> {
  const tweetApi = client.getTweetApi()
  const userApi = client.getUserApi()

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
      })
      return emptyTimeline
    }),
    // The trends-driven search timeline depends on an extra scraper library and a
    // legacy (non-GraphQL) endpoint, so it fails independently of the two OpenAPI
    // timelines above more often in practice — do not let it discard their results.
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
      })
      return emptyTimeline
    }),
  ])

  const allTweets = [...recommended.tweets, ...following.tweets, ...trending.tweets]
  const topTweets = sortByEngagement(allTweets).slice(0, deps.limits.topTweetsForReplies)

  // Authors of any tweet (timeline, reply, or profile) are not necessarily authors whose
  // full profile gets fetched below, e.g. a third party replying to a tracked tweet, or a
  // timeline author whose dedicated profile fetch fails (suspended/deleted account). Yet
  // Tweet.accountId is a required FK to Account, so every such author must be upserted
  // before persistTweets runs — falling back to the lighter profile data already embedded
  // in the tweet responses when a dedicated fetch never happened or failed.
  const extraAuthors = new Map<string, AccountProfileInput>()
  for (const author of [...recommended.authors, ...following.authors, ...trending.authors]) {
    extraAuthors.set(author.id, author)
  }
  const replyTweets: TweetInput[] = []
  // Third parties replying to someone else's high-engagement tweet are exactly the
  // accounts ad_reply_hijack (and other behavioral rules) need to see - a reply-hijacker
  // who never posts a viral tweet of their own would otherwise never enter the label
  // evaluation loop below, since that loop is keyed off timeline tweet authors.
  const replyHijackCandidateIds = new Set<string>()
  // The observed hijack reply itself is the actual evidence ad_reply_hijack needs to see -
  // without keeping it here, the candidate's label bundle below would only ever be built
  // from a separately-fetched, unrelated slice of their own tweet history (which may not
  // even include replies, depending on the endpoint), silently discarding the one reply
  // that got them flagged as a candidate in the first place.
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
    // Throttles the sequential per-author fetch loop against the same login account's
    // rate limit window — skipped before the first author since there is nothing to pace
    // against yet.
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

      const { tweets: recentTweets, authors } = await withTwitterRetry(
        () => fetchRecentTweets(userApi, authorId, deps.limits.recentTweetsPerAccount),
        retryOptions(deps),
      )
      profileTweets.push(...recentTweets)
      for (const author of authors) extraAuthors.set(author.id, author)

      const authorTimelineTweets = allTweets.filter((t) => t.accountId === authorId)
      // getUserTweetsAndReplies returns conversation-thread context alongside the
      // account's own posts - e.g. the parent tweet a reply is answering, authored by
      // someone else entirely. profileTweets above intentionally keeps those (each is
      // persisted under its own real author), but the label bundle must not: an
      // unrelated account's tweet leaking in here would corrupt every rule that reads
      // bundle.recentTweets for authorId.
      const authorOwnRecentTweets = recentTweets.filter((t) => t.accountId === authorId)
      const authorOtherReplies = otherRepliesByAuthor.get(authorId) ?? []
      const bundleTweets = mergeTweetAdFlags([
        ...authorTimelineTweets,
        ...authorOwnRecentTweets,
        ...authorOtherReplies,
      ])

      // The largest network size across this account's own reply tweets, since a single
      // account can post several different templated replies drawn from different
      // networks - the highest one is the strongest signal available.
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
        const message = `Failed to process author ${authorId}, skipping to next author`
        logger.error(message, error as Error)
        warnings.push({
          type: 'author_processing_failed',
          message,
          authorId,
          errorMessage: toErrorMessage(error),
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

interface SyncFollowGraphResult {
  followingSynced: boolean
  followersSynced: boolean
  warnings: CrawlWarning[]
}

/**
 * Syncs the login account's own following/follower lists against the `Follow` table.
 * Resolving the account's own user id and each direction's fetch-and-sync run in their
 * own independent try/catch: a failure resolving the id skips both directions, but once
 * resolved, a failure in one direction never prevents the other from running - and
 * neither ever aborts the rest of this account's crawl cycle.
 * @param deps - crawl dependencies (limits and the `syncFollowing`/`syncFollowers` persistence hooks)
 * @param account - the login account being crawled
 * @param client - the authenticated API client for this cycle
 * @returns which directions synced, plus a warning per step that failed
 */
async function syncFollowGraph(
  deps: CrawlDependencies,
  account: AppConfig['accounts'][number],
  client: CrawlOpenApiClient,
): Promise<SyncFollowGraphResult> {
  let userId: string
  const warnings: CrawlWarning[] = []
  try {
    const response = await withTwitterRetry(
      () => client.getUserApi().getUserByScreenName({ screenName: account.username }),
      retryOptions(deps),
    )
    userId = response.data.restId
    // The Follow table's `followerId`/`followeeId` are hard FKs to Account, and this
    // login account may never appear as a tweet/reply author elsewhere in this cycle -
    // so its own Account row must be upserted here, or every edge upsert below fails.
    await deps.persistAccount(toAccountProfileInput(response.data))
  } catch (error) {
    const message = `Failed to resolve or persist own account for ${account.username}, skipping follow/follower sync`
    logger.error(message, error as Error)
    warnings.push({
      type: 'own_account_sync_failed',
      message,
      username: account.username,
      errorMessage: toErrorMessage(error),
    })
    return { followingSynced: false, followersSynced: false, warnings }
  }

  let followingSynced = false
  try {
    const following = await withTwitterRetry(
      () => fetchFollowing(client.getUserListApi(), userId, deps.limits.followEdgesPerAccount),
      retryOptions(deps),
    )
    await deps.syncFollowing(userId, following)
    followingSynced = true
  } catch (error) {
    const message = `Failed to sync following for ${account.username}`
    logger.error(message, error as Error)
    warnings.push({
      type: 'following_sync_failed',
      message,
      username: account.username,
      errorMessage: toErrorMessage(error),
    })
  }

  let followersSynced = false
  try {
    const followers = await withTwitterRetry(
      () => fetchFollowers(client.getUserListApi(), userId, deps.limits.followEdgesPerAccount),
      retryOptions(deps),
    )
    await deps.syncFollowers(userId, followers)
    followersSynced = true
  } catch (error) {
    const message = `Failed to sync followers for ${account.username}`
    logger.error(message, error as Error)
    warnings.push({
      type: 'followers_sync_failed',
      message,
      username: account.username,
      errorMessage: toErrorMessage(error),
    })
  }

  return { followingSynced, followersSynced, warnings }
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
  try {
    const cookies = await deps.issueCookies({
      username: account.username,
      password: account.password,
      otp_secret: account.otpSecret,
    })

    const trendsContext = await deps.createTrendsScraper(cookies)
    let metrics: AccountCycleMetrics
    let syncResult: SyncFollowGraphResult
    try {
      const openApiContext = await deps.createOpenApiClient(cookies)
      try {
        metrics = await runAccountCycleBody(
          deps,
          registry,
          labelDefinitionIds,
          duplicateReplyIndex,
          replyHijackIndex,
          account,
          trendsContext,
          openApiContext.client,
        )
        syncResult = await syncFollowGraph(deps, account, openApiContext.client)
      } finally {
        await deps.closeOpenApiClient(openApiContext)
      }
    } finally {
      await deps.closeTrendsScraper(trendsContext)
    }

    // Every remaining warning has already survived retrying (withTwitterRetry, above) and
    // routine-failure filtering (isExpectedAccountLookupError, above) - what's left is a
    // fetch or sync step that failed with no fallback, so any single one is still worth
    // surfacing as 'partial' rather than being averaged away.
    const warnings = [...metrics.warnings, ...syncResult.warnings]
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
      followingSynced: syncResult.followingSynced,
      followersSynced: syncResult.followersSynced,
      warnings,
      errorMessage: null,
    })
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
      warnings: [],
      errorMessage: String(error),
    })
    throw error
  }
}

export async function runCrawlCycle(deps: CrawlDependencies): Promise<void> {
  const registry = new LabelRuleRegistry()
  for (const rule of ALL_LABEL_RULES) registry.register(rule)
  const labelDefinitionIds = await deps.ensureLabelDefinitions(registry)
  // Built once per cycle from the whole reply corpus, not per-account, since detecting a
  // templated-reply network is inherently a cross-account comparison.
  const replyCorpus = await deps.loadReplyCorpus()
  const duplicateReplyIndex = buildDuplicateReplyIndex(replyCorpus)
  const replyHijackIndex = buildReplyHijackIndex(replyCorpus)

  const { id: crawlRunId } = await deps.startCrawlRun(new Date())

  // Everything below this point is wrapped so that any exception - an unexpected
  // error escaping the per-account loop's own try/catch, for example - still
  // finalizes the CrawlRun as 'failed' instead of leaving it at the 'running'
  // placeholder forever. Two cases can't be covered: a killed process (OOM, forced
  // container stop), where no code runs to react to it; and the finalize write
  // itself failing (see the inner try/catch below), where the failure that put us
  // here is also what stops us from recording it.
  try {
    const accountStatuses: ('success' | 'partial' | 'failed')[] = []

    for (const account of deps.config.accounts) {
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
    }

    const runStatus = accountStatuses.includes('failed')
      ? 'failed'
      : accountStatuses.includes('partial')
        ? 'partial'
        : 'success'
    await deps.finishCrawlRun(crawlRunId, new Date(), runStatus)
  } catch (error) {
    try {
      await deps.finishCrawlRun(crawlRunId, new Date(), 'failed')
    } catch (finalizeError) {
      // The DB write that would mark this CrawlRun as 'failed' failed itself (most
      // likely the same outage that caused `error` in the first place). Log it and
      // still rethrow the original `error` below - losing that in favor of this
      // secondary failure would be worse, and the row is left at 'running' either way.
      logger.error('Failed to finalize the CrawlRun as failed', finalizeError as Error)
    }
    throw error
  }
}

/**
 * Wraps the real `twitter-openapi-typescript` client into a `CrawlOpenApiClient`,
 * combining `./twitter/timeline`'s and `./twitter/engagement`'s adapters (both wrap the
 * same underlying real tweet API) into a single object satisfying the
 * `TweetApiLike & TweetDetailApiLike` intersection, and `./twitter/profile`'s adapter for
 * the user API.
 * @param realClient - an authenticated real `TwitterOpenApiClient`
 * @returns a `CrawlOpenApiClient` usable with {@link runCrawlCycle}
 */
function toCrawlOpenApiClient(
  realClient: Awaited<ReturnType<typeof createRealOpenApiClient>>['client'],
): CrawlOpenApiClient {
  return {
    getTweetApi: () => ({
      ...createTweetApiLike(realClient.getTweetApi()),
      ...createTweetDetailApiLike(realClient.getTweetApi()),
    }),
    getUserApi: () => createUserApiLike(realClient.getUserApi(), realClient.getTweetApi()),
    getUserListApi: () => createFollowListApiLike(realClient.getUserListApi()),
  }
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  const cookieIssuer = createCookieIssuerClient({
    baseUrl: getCookieIssuerBaseUrl(),
  })

  const deps: CrawlDependencies = {
    config: loadConfig(),
    limits: CRAWL_LIMITS,
    issueCookies: (account) => cookieIssuer.issueCookiesWithRetry(account),
    createOpenApiClient: async (cookies) => {
      const context = await createRealOpenApiClient(cookies)
      return { ...context, client: toCrawlOpenApiClient(context.client) }
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
      await recordAccountLabel(prisma, params)
    },
    syncFollowing: (followerId, result) => syncFollowingEdges(prisma, followerId, result),
    syncFollowers: (followeeId, result) => syncFollowersEdges(prisma, followeeId, result),
    startCrawlRun: (startedAt) => startCrawlRunRecord(prisma, startedAt),
    finishCrawlRun: (id, finishedAt, status) =>
      finishCrawlRunRecord(prisma, id, finishedAt, status),
    recordCrawlAccountRun: (params) => recordCrawlAccountRunRecord(prisma, params),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  }

  try {
    await runCrawlCycle(deps)
  } finally {
    await disconnectPrisma()
  }
}

// Guarded so importing this module (e.g. from crawl.test.ts) never triggers a real
// crawl cycle — only running it directly (`node dist/crawl.js`) does. require/module
// are the correct CommonJS-native way to detect this (project is CommonJS, not ESM).
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  initMonitoring()
  main().catch((error: unknown) => {
    logger.error('Crawl cycle failed', error as Error)
    captureException(error)
    process.exitCode = 1
  })
}
