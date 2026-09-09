import { Logger } from '@book000/node-utils'
import { captureException, initMonitoring } from './monitoring/sentry'
import { loadConfig } from './config/load-config'
import { CRAWL_LIMITS, SELF_REPLY_PROMO_CHAIN_LIMITS } from './config/crawl-limits'
import { getCookieIssuerBaseUrl } from './config/env'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { upsertAccount, type AccountProfileInput } from './db/account-repository'
import { upsertTweets, type TweetInput } from './db/tweet-repository'
import { requestAccountRelabelBulk } from './db/analysis-work-item-repository'
import {
  createCookieIssuerClient,
  createOpenApiClient,
  closeOpenApiClient,
  toAccountProfileInput,
  toTweetInput,
  mergeTweetAdFlags,
} from 'twitter-client'
import { createTweetApiLike, type TweetApiLike } from './twitter/timeline'
import {
  createTweetDetailApiLike,
  fetchReplies,
  type TweetDetailApiLike,
} from './twitter/engagement'
import {
  fetchAccountProfile,
  fetchRecentTweets,
  createUserApiLike,
  type UserApiLike,
} from './twitter/profile'
import { fetchSelfReplyChain, hasThirdPartyStatusLink } from './twitter/self-reply-chain'
import { TweetDetailRateLimitBudget } from './twitter/tweet-detail-rate-limit-budget'

const logger = Logger.configure('crawl-tweet')

export interface ManualCrawlOpenApiClient {
  getTweetApi(): TweetApiLike & TweetDetailApiLike
  getUserApi(): UserApiLike
}

export interface ManualTweetCrawlDependencies {
  client: ManualCrawlOpenApiClient
  persistAccount: (input: AccountProfileInput) => Promise<void>
  persistTweets: (inputs: TweetInput[]) => Promise<void>
  /** recent tweets 取得成功時に `Account.recentTweetsFetchStatus` 等を更新する。 */
  recordRecentTweetsFetchSuccess: (accountId: string, fetchedAt: Date) => Promise<void>
  /** recent tweets 取得失敗時に `Account.recentTweetsFetchStatus` 等を更新する。既存の fetchedAt は消さない。 */
  recordRecentTweetsFetchFailure: (accountId: string, attemptedAt: Date) => Promise<void>
  /** 既存ラベル有無でフィルタしない account_relabel の一括要求。 */
  requestAccountRelabel: (accountIds: string[]) => Promise<void>
  recentTweetsPerAccount: number
  repliesPerTweet: number
  tweetDetailRateLimitBudget: TweetDetailRateLimitBudget
}

export interface ManualTweetCrawlResult {
  repliesFound: number
  accountsProcessed: number
}

/**
 * ラベル付け自体はここでは行わず、後続の relabel バックフィルに委ねる。
 * @param deps - 注入されたクライアントと永続化関数
 * @param tweetId - 対象ツイートの rest id
 * @returns 発見した返信数と重複排除後の投稿者数
 */
export async function runManualTweetCrawl(
  deps: ManualTweetCrawlDependencies,
  tweetId: string,
): Promise<ManualTweetCrawlResult> {
  const tweetApi = deps.client.getTweetApi()
  const userApi = deps.client.getUserApi()

  const response = await tweetApi.getTweetDetail({ focalTweetId: tweetId })
  const rawEntries = response.data.data

  const focalRaw = rawEntries.find((entry) => entry.restId === tweetId)
  if (!focalRaw) {
    throw new Error(`Focal tweet ${tweetId} not found in tweet detail response`)
  }

  const parentTweet = toTweetInput(focalRaw, {
    source: 'manual',
    viewerAccountId: focalRaw.user.restId,
  })

  const {
    authorReplies,
    otherReplies,
    authors: replyAuthors,
  } = await fetchReplies(tweetApi, parentTweet, deps.repliesPerTweet)
  const replies = [...authorReplies, ...otherReplies]
  const persistedReplyTweets = [...replies]

  for (const reply of authorReplies) {
    if (!hasThirdPartyStatusLink(reply.expandedUrls)) continue
    const chainNodes = await fetchSelfReplyChain(tweetApi, deps.tweetDetailRateLimitBudget, reply, {
      maxDepth: SELF_REPLY_PROMO_CHAIN_LIMITS.maxDepth,
      maxNodesPerRoot: SELF_REPLY_PROMO_CHAIN_LIMITS.maxNodesPerRoot,
    })
    persistedReplyTweets.push(...chainNodes)
  }

  // 専用のプロフィール取得だけに頼らない: 対象アカウントが凍結等で取得に失敗した場合に備え、
  // レスポンスに埋め込まれたプロフィールもフォールバックとして保持する。
  const extraAuthors = new Map<string, AccountProfileInput>()
  for (const entry of rawEntries)
    extraAuthors.set(entry.user.restId, toAccountProfileInput(entry.user))
  for (const author of replyAuthors) extraAuthors.set(author.id, author)

  const replyAuthorIds = [...new Set(replies.map((reply) => reply.accountId))]
  const succeededAuthorIds = new Set<string>()
  const profileTweets: TweetInput[] = []

  for (const authorId of [focalRaw.user.restId, ...replyAuthorIds]) {
    let profile: AccountProfileInput
    try {
      profile = await fetchAccountProfile(userApi, authorId)
    } catch (error) {
      logger.error(
        `Failed to fetch full profile for author ${authorId}, falling back to embedded profile data`,
        error as Error,
      )
      continue
    }
    await deps.persistAccount(profile)
    succeededAuthorIds.add(authorId)

    // profile 取得自体が失敗した場合はここに到達しないため、
    // recent tweets を一度も試みていないことと fetch 失敗を取り違えない。
    const recentTweetsAttemptedAt = new Date()
    let recentTweetsFetchSucceeded = false
    try {
      const { tweets: recentTweets, authors } = await fetchRecentTweets(
        userApi,
        authorId,
        deps.recentTweetsPerAccount,
      )
      profileTweets.push(...recentTweets)
      for (const author of authors) extraAuthors.set(author.id, author)
      recentTweetsFetchSucceeded = true
    } catch (error) {
      logger.error(`Failed to fetch recent tweets for author ${authorId}`, error as Error)
      await deps.recordRecentTweetsFetchFailure(authorId, recentTweetsAttemptedAt)
    }
    // 成功ステータスの永続化自体が失敗した場合、それは fetch 失敗ではないため、
    // 上記の catch で fetch 失敗として誤記録しないよう try/catch の外で呼ぶ。
    if (recentTweetsFetchSucceeded) {
      await deps.recordRecentTweetsFetchSuccess(authorId, new Date())
    }
  }

  for (const [id, profile] of extraAuthors) {
    if (succeededAuthorIds.has(id)) continue
    await deps.persistAccount(profile)
  }

  await deps.persistTweets(
    mergeTweetAdFlags([parentTweet, ...persistedReplyTweets, ...profileTweets]),
  )

  // tweet と recent-tweets fetch status の永続化が完了した後にのみ enqueue する。
  // 先に enqueue すると relabel worker が不完全な状態を評価し得る。
  // 既存ラベル有無でフィルタしない: 新規アカウントも初回 relabel の対象にする。
  await deps.requestAccountRelabel([...new Set([focalRaw.user.restId, ...replyAuthorIds])])

  return { repliesFound: replies.length, accountsProcessed: succeededAuthorIds.size }
}

async function main(): Promise<void> {
  const tweetId = process.argv[2]
  if (!tweetId) {
    logger.error('Usage: node dist/crawl-tweet.js <tweetId>')
    process.exitCode = 1
    return
  }

  const prisma = getPrismaClient()
  const config = loadConfig()
  const [account] = config.accounts
  const cookieIssuer = createCookieIssuerClient({
    baseUrl: getCookieIssuerBaseUrl(),
    clientName: 'crawler',
  })

  const cookies = await cookieIssuer.issueCookiesWithRetry({
    username: account.username,
    password: account.password,
    otp_secret: account.otpSecret,
  })
  const openApiContext = await createOpenApiClient(cookies)

  try {
    const client: ManualCrawlOpenApiClient = {
      getTweetApi: () => ({
        ...createTweetApiLike(openApiContext.client.getTweetApi()),
        ...createTweetDetailApiLike(openApiContext.client.getTweetApi()),
      }),
      getUserApi: () =>
        createUserApiLike(openApiContext.client.getUserApi(), openApiContext.client.getTweetApi()),
    }

    const result = await runManualTweetCrawl(
      {
        client,
        persistAccount: async (input) => {
          await upsertAccount(prisma, input)
        },
        persistTweets: async (inputs) => {
          await upsertTweets(prisma, inputs)
        },
        recordRecentTweetsFetchSuccess: async (accountId, fetchedAt) => {
          await prisma.account.update({
            where: { id: accountId },
            data: {
              lastRecentTweetsAttemptedAt: fetchedAt,
              lastRecentTweetsFetchedAt: fetchedAt,
              recentTweetsFetchStatus: 'success',
            },
          })
        },
        recordRecentTweetsFetchFailure: async (accountId, attemptedAt) => {
          await prisma.account.update({
            where: { id: accountId },
            data: { lastRecentTweetsAttemptedAt: attemptedAt, recentTweetsFetchStatus: 'failed' },
          })
        },
        requestAccountRelabel: (accountIds) => requestAccountRelabelBulk(prisma, accountIds),
        recentTweetsPerAccount: CRAWL_LIMITS.recentTweetsPerAccount,
        repliesPerTweet: CRAWL_LIMITS.repliesPerTweet,
        tweetDetailRateLimitBudget: new TweetDetailRateLimitBudget({ now: Date.now }),
      },
      tweetId,
    )
    logger.info(
      `Manual tweet crawl complete for ${tweetId}: ${result.repliesFound} replies found, ${result.accountsProcessed} accounts processed`,
    )
  } finally {
    await closeOpenApiClient(openApiContext)
    await disconnectPrisma()
  }
}

// import.meta ではなく require/module を使う: このプロジェクトは CommonJS であり ESM ではないため。
// eslint-disable-next-line unicorn/prefer-module
if (require.main === module) {
  initMonitoring()
  main().catch((error: unknown) => {
    logger.error('Manual tweet crawl failed', error as Error)
    captureException(error)
    process.exitCode = 1
  })
}
