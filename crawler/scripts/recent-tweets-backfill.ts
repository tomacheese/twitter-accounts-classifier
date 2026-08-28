import type { PrismaClient } from '../generated/prisma'
import { loadConfig, type AppConfig, type TwitterAccountConfig } from '../config/load-config'
import { CRAWL_LIMITS, TWITTER_RETRY } from '../config/crawl-limits'
import { getCookieIssuerBaseUrl, getTwitterRequestTimeoutMs } from '../config/env'
import { getPrismaClient, disconnectPrisma } from '../db/client'
import { upsertAccount, type AccountProfileInput } from '../db/account-repository'
import { upsertAccountRequestingRelabelIfChanged } from '../db/account-relabel-on-change'
import { upsertTweet, type TweetInput } from '../db/tweet-repository'
import { requestAccountRelabelBulk } from '../db/analysis-work-item-repository'
import {
  selectRecentTweetsBackfillCandidates,
  type RecentTweetsBackfillCandidateOptions,
  type RecentTweetsBackfillCandidatePage,
} from '../db/recent-tweets-backfill-repository'
import {
  createCookieIssuerClient,
  createOpenApiClient,
  closeOpenApiClient,
  mergeTweetAdFlags,
  withTimeout,
  withTwitterRateLimitRetry,
  withTwitterRetry,
} from 'twitter-client'
import {
  createUserApiLike,
  fetchAccountProfile,
  fetchRecentTweets,
  type RecentTweetsResult,
  type UserApiLike,
} from '../twitter/profile'

const DEFAULT_LIMIT = 100

export interface BackfillOptions extends RecentTweetsBackfillCandidateOptions {
  execute: boolean
  username?: string
}

export interface AuthenticatedUserApi {
  userApi: UserApiLike
  close: () => Promise<void>
}

/**
 * credential-bearing OpenAPI context を UserApiLike に変換し、変換途中の例外でも context を閉じる。
 * @param context - close が必要な OpenAPI context
 * @param adapt - context から UserApiLike を構築する処理
 * @param closeContext - context の close 処理
 * @returns 変換済み API と通常終了時の close 処理
 */
async function createAuthenticatedUserApiWithCleanup<TContext>(
  context: TContext,
  adapt: (context: TContext) => UserApiLike,
  closeContext: (context: TContext) => Promise<void>,
): Promise<AuthenticatedUserApi> {
  try {
    const userApi = adapt(context)
    return { userApi, close: () => closeContext(context) }
  } catch (error) {
    await closeContext(context)
    throw error
  }
}

export interface AuthenticatedUserApiFactoryDependencies {
  getCookieIssuerBaseUrl: typeof getCookieIssuerBaseUrl
  createCookieIssuerClient: typeof createCookieIssuerClient
  createOpenApiClient: typeof createOpenApiClient
  closeOpenApiClient: typeof closeOpenApiClient
  createUserApiLike: typeof createUserApiLike
}

const AUTHENTICATED_USER_API_FACTORY_DEPENDENCIES: AuthenticatedUserApiFactoryDependencies = {
  getCookieIssuerBaseUrl,
  createCookieIssuerClient,
  createOpenApiClient,
  closeOpenApiClient,
  createUserApiLike,
}

/**
 * 指定済み account の cookie と OpenAPI client を作り、backfill 用 UserApiLike に変換する。
 * @param account - username で選択済みの設定 account
 * @param requestTimeoutMs - OpenAPI request timeout
 * @param deps - cookie/OpenAPI client 構築と cleanup の依存関係
 * @returns 認証済み UserApiLike と close 処理
 */
export async function createConfiguredAuthenticatedUserApi(
  account: TwitterAccountConfig,
  requestTimeoutMs: number,
  deps: AuthenticatedUserApiFactoryDependencies = AUTHENTICATED_USER_API_FACTORY_DEPENDENCIES,
): Promise<AuthenticatedUserApi> {
  const cookieIssuer = deps.createCookieIssuerClient({
    baseUrl: deps.getCookieIssuerBaseUrl(),
    clientName: 'crawler',
  })
  const cookies = await cookieIssuer.issueCookiesWithRetry({
    username: account.username,
    password: account.password,
    otp_secret: account.otpSecret,
  })
  const context = await deps.createOpenApiClient(cookies, requestTimeoutMs)
  return createAuthenticatedUserApiWithCleanup(
    context,
    (openApiContext) =>
      deps.createUserApiLike(
        openApiContext.client.getUserApi(),
        openApiContext.client.getTweetApi(),
      ),
    deps.closeOpenApiClient,
  )
}

export interface RecentTweetsBackfillDependencies {
  prisma: PrismaClient
  selectCandidates: (
    prisma: PrismaClient,
    options: RecentTweetsBackfillCandidateOptions,
  ) => Promise<RecentTweetsBackfillCandidatePage>
  loadConfig: () => AppConfig
  createAuthenticatedUserApi: (
    account: TwitterAccountConfig,
    requestTimeoutMs: number,
  ) => Promise<AuthenticatedUserApi>
  fetchAccountProfile: (client: UserApiLike, accountId: string) => Promise<AccountProfileInput>
  fetchRecentTweets: (
    client: UserApiLike,
    accountId: string,
    limit: number,
  ) => Promise<RecentTweetsResult>
  upsertAccount: typeof upsertAccount
  /**
   * context tweet の author (backfill 対象本人ではない fallback author) の永続化用。
   * この account はここでしか profile 更新を観測できないため、
   * plain な {@link upsertAccount} ではなく変化検知つきで upsert し、
   * ラベル評価に影響する変化があれば relabel も併せて要求する。
   */
  upsertFallbackAuthor: typeof upsertAccountRequestingRelabelIfChanged
  upsertTweet: typeof upsertTweet
  requestAccountRelabelBulk: typeof requestAccountRelabelBulk
  getRequestTimeoutMs: () => number
  now: () => Date
  log: (message: string) => void
  logError: (message: string) => void
  disconnectPrisma: () => Promise<void>
}

function readValue(args: string[], index: number, option: string): string {
  const value = args.at(index + 1)
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

/**
 * backfill CLI の引数を検証して正規化する。
 * @param args - process.argv の script 名より後ろの引数
 * @returns 検証済みの実行オプション
 */
export function parseOptions(args: string[]): BackfillOptions {
  let limit = DEFAULT_LIMIT
  let afterId: string | undefined
  let username: string | undefined
  let dryRunSpecified = false
  let execute = false
  const seen = new Set<string>()

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (!['--limit', '--after-id', '--username', '--dry-run', '--execute'].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`)
    }
    if (seen.has(argument)) throw new Error(`Duplicate argument: ${argument}`)
    seen.add(argument)

    if (argument === '--dry-run') {
      dryRunSpecified = true
      continue
    }
    if (argument === '--execute') {
      execute = true
      continue
    }

    const value = readValue(args, index, argument)
    index += 1
    if (argument === '--limit') {
      if (!/^\d+$/.test(value)) throw new Error('Limit must be an integer from 1 to 1000')
      limit = Number(value)
    } else if (argument === '--after-id') {
      afterId = value
    } else {
      username = value
    }
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Limit must be an integer from 1 to 1000')
  }
  if (dryRunSpecified && execute) throw new Error('Cannot combine --dry-run and --execute')
  if (execute && username === undefined) throw new Error('--execute requires --username')
  if (!execute && username !== undefined) throw new Error('--username requires --execute')

  return {
    limit,
    ...(afterId === undefined ? {} : { afterId }),
    execute,
    ...(username === undefined ? {} : { username }),
  }
}

async function fetchWithCrawlPolicy<T>(
  operation: () => Promise<T>,
  requestTimeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return withTwitterRateLimitRetry(() =>
    withTwitterRetry(
      () => withTimeout(operation(), requestTimeoutMs, timeoutMessage),
      TWITTER_RETRY,
    ),
  )
}

/** coverage の先行更新時に success transaction 全体を rollback するための内部エラー。 */
class StaleRecentTweetsBackfillWriteError extends Error {}

async function persistSuccessfulCandidate(
  deps: RecentTweetsBackfillDependencies,
  accountId: string,
  profile: AccountProfileInput,
  recentTweets: RecentTweetsResult,
  attemptedAt: Date,
  fetchedAt: Date,
): Promise<void> {
  const fallbackAuthors = new Map(
    recentTweets.authors.map((fallbackAuthor) => [fallbackAuthor.id, fallbackAuthor]),
  )
  const tweets: TweetInput[] = mergeTweetAdFlags(recentTweets.tweets)

  try {
    await deps.prisma.$transaction(
      async (transaction) => {
        const tx = transaction as unknown as PrismaClient
        await deps.upsertAccount(tx, profile)
        for (const fallbackAuthor of fallbackAuthors.values()) {
          if (fallbackAuthor.id === profile.id) continue
          await deps.upsertFallbackAuthor(tx, fallbackAuthor)
        }
        for (const tweet of tweets) {
          await deps.upsertTweet(tx, tweet)
        }
        const coverage = await tx.account.updateMany({
          where: { id: accountId, lastRecentTweetsAttemptedAt: null },
          data: {
            lastRecentTweetsAttemptedAt: attemptedAt,
            lastRecentTweetsFetchedAt: fetchedAt,
            recentTweetsFetchStatus: 'success',
          },
        })
        if (coverage.count !== 1) {
          throw new StaleRecentTweetsBackfillWriteError(
            `Recent tweets backfill coverage is stale for ${accountId}`,
          )
        }
        await deps.requestAccountRelabelBulk(tx, [accountId])
      },
      { maxWait: 30_000, timeout: 30_000 },
    )
  } catch (error) {
    if (error instanceof StaleRecentTweetsBackfillWriteError) return
    throw error
  }
}

async function recordFailedCandidate(
  deps: RecentTweetsBackfillDependencies,
  accountId: string,
  attemptedAt: Date,
): Promise<void> {
  await deps.prisma.account.updateMany({
    where: { id: accountId, lastRecentTweetsAttemptedAt: null },
    data: {
      lastRecentTweetsAttemptedAt: attemptedAt,
      recentTweetsFetchStatus: 'failed',
    },
  })
}

/**
 * recent tweets backfill を dry-run または明示的な execute mode で実行する。
 * @param args - CLI 引数
 * @param deps - 外部通信・永続化を含む依存関係
 */
export async function runRecentTweetsBackfill(
  args: string[],
  deps: RecentTweetsBackfillDependencies,
): Promise<void> {
  let authenticated: AuthenticatedUserApi | undefined
  try {
    const options = parseOptions(args)
    let configuredAccount: TwitterAccountConfig | undefined
    if (options.execute) {
      const config = deps.loadConfig()
      configuredAccount = config.accounts.find((account) => account.username === options.username)
      if (configuredAccount === undefined) {
        throw new Error(`Configured account not found: ${options.username}`)
      }
    }

    const candidates = await deps.selectCandidates(deps.prisma, options)
    deps.log(JSON.stringify({ mode: options.execute ? 'execute' : 'dry-run', ...candidates }))
    if (!options.execute || candidates.accountIds.length === 0) return
    if (configuredAccount === undefined) {
      throw new Error('Execute account is missing after validation')
    }

    const requestTimeoutMs = deps.getRequestTimeoutMs()
    authenticated = await deps.createAuthenticatedUserApi(configuredAccount, requestTimeoutMs)
    const userApi = authenticated.userApi

    for (const accountId of candidates.accountIds) {
      const attemptedAt = deps.now()
      let profile: AccountProfileInput
      let recentTweets: RecentTweetsResult
      try {
        profile = await fetchWithCrawlPolicy(
          () => deps.fetchAccountProfile(userApi, accountId),
          requestTimeoutMs,
          `Profile fetch for ${accountId} timed out`,
        )
        recentTweets = await fetchWithCrawlPolicy(
          () => deps.fetchRecentTweets(userApi, accountId, CRAWL_LIMITS.recentTweetsPerAccount),
          requestTimeoutMs,
          `Recent tweets fetch for ${accountId} timed out`,
        )
      } catch {
        await recordFailedCandidate(deps, accountId, attemptedAt)
        deps.logError(`Recent tweets backfill fetch failed for ${accountId}`)
        continue
      }

      await persistSuccessfulCandidate(
        deps,
        accountId,
        profile,
        recentTweets,
        attemptedAt,
        deps.now(),
      )
    }
  } finally {
    try {
      if (authenticated !== undefined) await authenticated.close()
    } finally {
      await deps.disconnectPrisma()
    }
  }
}

function createDefaultDependencies(prisma: PrismaClient): RecentTweetsBackfillDependencies {
  return {
    prisma,
    selectCandidates: selectRecentTweetsBackfillCandidates,
    loadConfig,
    createAuthenticatedUserApi: createConfiguredAuthenticatedUserApi,
    fetchAccountProfile,
    fetchRecentTweets,
    upsertAccount,
    upsertFallbackAuthor: upsertAccountRequestingRelabelIfChanged,
    upsertTweet,
    requestAccountRelabelBulk,
    getRequestTimeoutMs: getTwitterRequestTimeoutMs,
    now: () => new Date(),
    log: console.log,
    logError: console.error,
    disconnectPrisma,
  }
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  await runRecentTweetsBackfill(process.argv.slice(2), createDefaultDependencies(prisma))
}

// import.meta ではなく require/module を使う: このプロジェクトは CommonJS であるため。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
