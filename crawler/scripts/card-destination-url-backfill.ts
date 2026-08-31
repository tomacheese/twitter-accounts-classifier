import type { PrismaClient } from '../generated/prisma'
import { loadConfig, type AppConfig, type TwitterAccountConfig } from '../config/load-config'
import { CRAWL_LIMITS, TWITTER_RETRY } from '../config/crawl-limits'
import { getTwitterRequestTimeoutMs } from '../config/env'
import { getPrismaClient, disconnectPrisma } from '../db/client'
import { upsertAccount, type AccountProfileInput } from '../db/account-repository'
import { upsertAccountRequestingRelabelIfChanged } from '../db/account-relabel-on-change'
import { upsertTweet, type TweetInput } from '../db/tweet-repository'
import { requestAccountRelabelBulk } from '../db/analysis-work-item-repository'
import {
  selectCardDestinationUrlBackfillCandidates,
  type CardDestinationUrlBackfillCandidateOptions,
  type CardDestinationUrlBackfillCandidatePage,
} from '../db/card-destination-url-backfill-repository'
import {
  mergeTweetAdFlags,
  withTimeout,
  withTwitterRateLimitRetry,
  withTwitterRetry,
} from 'twitter-client'
import { fetchAccountProfile, fetchRecentTweets, type RecentTweetsResult } from '../twitter/profile'
import {
  createConfiguredAuthenticatedUserApi,
  parseOptions,
  type AuthenticatedUserApi,
  type BackfillOptions,
} from './recent-tweets-backfill'

export interface CardDestinationUrlBackfillDependencies {
  prisma: PrismaClient
  selectCandidates: (
    prisma: PrismaClient,
    options: CardDestinationUrlBackfillCandidateOptions,
  ) => Promise<CardDestinationUrlBackfillCandidatePage>
  loadConfig: () => AppConfig
  createAuthenticatedUserApi: (
    account: TwitterAccountConfig,
    requestTimeoutMs: number,
  ) => Promise<AuthenticatedUserApi>
  fetchAccountProfile: typeof fetchAccountProfile
  fetchRecentTweets: typeof fetchRecentTweets
  upsertAccount: typeof upsertAccount
  /** context tweet の author (backfill 対象本人ではない fallback author) の永続化用。 */
  upsertFallbackAuthor: typeof upsertAccountRequestingRelabelIfChanged
  upsertTweet: typeof upsertTweet
  requestAccountRelabelBulk: typeof requestAccountRelabelBulk
  getRequestTimeoutMs: () => number
  log: (message: string) => void
  logError: (message: string) => void
  disconnectPrisma: () => Promise<void>
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

/**
 * account 本体・fallback author・Card を含む再取得済みツイートを永続化し、
 * `upsertTweet` の変化検知で Card 関連フィールドが実際に変化したツイートが1件でもあれば relabel を要求する。
 * 変化がなければ何もしない。
 * @param deps - 永続化に使う依存関係
 * @param accountId - backfill 対象の account ID
 * @param profile - 再取得した account プロフィール
 * @param recentTweets - 再取得した直近ツイートと context author
 */
async function persistCandidate(
  deps: CardDestinationUrlBackfillDependencies,
  accountId: string,
  profile: AccountProfileInput,
  recentTweets: RecentTweetsResult,
): Promise<void> {
  const fallbackAuthors = new Map(
    recentTweets.authors.map((fallbackAuthor) => [fallbackAuthor.id, fallbackAuthor]),
  )
  const tweets: TweetInput[] = mergeTweetAdFlags(recentTweets.tweets)

  await deps.prisma.$transaction(
    async (transaction) => {
      const tx = transaction as unknown as PrismaClient
      await deps.upsertAccount(tx, profile)
      for (const fallbackAuthor of fallbackAuthors.values()) {
        if (fallbackAuthor.id === profile.id) continue
        await deps.upsertFallbackAuthor(tx, fallbackAuthor)
      }
      let anyTweetChanged = false
      for (const tweet of tweets) {
        const result = await deps.upsertTweet(tx, tweet)
        if (result.changed) anyTweetChanged = true
      }
      if (anyTweetChanged) {
        await deps.requestAccountRelabelBulk(tx, [accountId])
      }
    },
    { maxWait: 30_000, timeout: 30_000 },
  )
}

/**
 * `ad_pr_hashtag=true` かつ Card 未評価の Tweet を持つ account の recent tweets を再取得し、
 * Card destination URL を dry-run または明示的な execute mode で backfill する。
 * @param args - CLI 引数 (`recent-tweets-backfill` と同じ `--limit`/`--after-id`/`--username`/`--dry-run`/`--execute`)
 * @param deps - 外部通信・永続化を含む依存関係
 */
export async function runCardDestinationUrlBackfill(
  args: string[],
  deps: CardDestinationUrlBackfillDependencies,
): Promise<void> {
  let authenticated: AuthenticatedUserApi | undefined
  try {
    const options: BackfillOptions = parseOptions(args)
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
        deps.logError(`Card destination URL backfill fetch failed for ${accountId}`)
        continue
      }

      await persistCandidate(deps, accountId, profile, recentTweets)
    }
  } finally {
    try {
      if (authenticated !== undefined) await authenticated.close()
    } finally {
      await deps.disconnectPrisma()
    }
  }
}

function createDefaultDependencies(prisma: PrismaClient): CardDestinationUrlBackfillDependencies {
  return {
    prisma,
    selectCandidates: selectCardDestinationUrlBackfillCandidates,
    loadConfig,
    createAuthenticatedUserApi: createConfiguredAuthenticatedUserApi,
    fetchAccountProfile,
    fetchRecentTweets,
    upsertAccount,
    upsertFallbackAuthor: upsertAccountRequestingRelabelIfChanged,
    upsertTweet,
    requestAccountRelabelBulk,
    getRequestTimeoutMs: getTwitterRequestTimeoutMs,
    log: console.log,
    logError: console.error,
    disconnectPrisma,
  }
}

async function main(): Promise<void> {
  const prisma = getPrismaClient()
  await runCardDestinationUrlBackfill(process.argv.slice(2), createDefaultDependencies(prisma))
}

// import.meta ではなく require/module を使う: このプロジェクトは CommonJS であるため。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
