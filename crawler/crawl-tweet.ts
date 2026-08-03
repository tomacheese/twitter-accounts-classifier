import { Logger } from '@book000/node-utils'
import { captureException, initMonitoring } from './monitoring/sentry'
import { loadConfig } from './config/load-config'
import { CRAWL_LIMITS } from './config/crawl-limits'
import { getCookieIssuerBaseUrl } from './config/env'
import { getPrismaClient, disconnectPrisma } from './db/client'
import { upsertAccount, type AccountProfileInput } from './db/account-repository'
import { upsertTweets, type TweetInput } from './db/tweet-repository'
import { createCookieIssuerClient } from 'twitter-client'
import {
  createOpenApiClient as createRealOpenApiClient,
  closeOpenApiClient as closeRealOpenApiClient,
} from './twitter/client'
import { createTweetApiLike, type TweetApiLike } from './twitter/timeline'
import { createTweetDetailApiLike, type TweetDetailApiLike } from './twitter/engagement'
import {
  fetchAccountProfile,
  fetchRecentTweets,
  createUserApiLike,
  type UserApiLike,
} from './twitter/profile'
import { toAccountProfileInput, toTweetInput, mergeTweetAdFlags } from './twitter/mappers'

const logger = Logger.configure('crawl-tweet')

export interface ManualCrawlOpenApiClient {
  getTweetApi(): TweetApiLike & TweetDetailApiLike
  getUserApi(): UserApiLike
}

export interface ManualTweetCrawlDependencies {
  client: ManualCrawlOpenApiClient
  persistAccount: (input: AccountProfileInput) => Promise<void>
  persistTweets: (inputs: TweetInput[]) => Promise<void>
  recentTweetsPerAccount: number
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
  const replies = rawEntries
    .filter((entry) => entry.legacy.inReplyToStatusIdStr === tweetId)
    .map((entry) =>
      toTweetInput(entry, { source: 'manual', viewerAccountId: focalRaw.user.restId }),
    )

  // 専用のプロフィール取得だけに頼らない: 対象アカウントが凍結等で取得に失敗した場合に備え、
  // レスポンスに埋め込まれたプロフィールもフォールバックとして保持する。
  const extraAuthors = new Map<string, AccountProfileInput>()
  for (const entry of rawEntries)
    extraAuthors.set(entry.user.restId, toAccountProfileInput(entry.user))

  const replyAuthorIds = [...new Set(replies.map((reply) => reply.accountId))]
  const succeededAuthorIds = new Set<string>()
  const profileTweets: TweetInput[] = []

  for (const authorId of [focalRaw.user.restId, ...replyAuthorIds]) {
    try {
      const profile = await fetchAccountProfile(userApi, authorId)
      await deps.persistAccount(profile)
      succeededAuthorIds.add(authorId)

      const { tweets: recentTweets, authors } = await fetchRecentTweets(
        userApi,
        authorId,
        deps.recentTweetsPerAccount,
      )
      profileTweets.push(...recentTweets)
      for (const author of authors) extraAuthors.set(author.id, author)
    } catch (error) {
      logger.error(
        `Failed to fetch full profile for author ${authorId}, falling back to embedded profile data`,
        error as Error,
      )
    }
  }

  for (const [id, profile] of extraAuthors) {
    if (succeededAuthorIds.has(id)) continue
    await deps.persistAccount(profile)
  }

  await deps.persistTweets(mergeTweetAdFlags([parentTweet, ...replies, ...profileTweets]))

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
  })

  const cookies = await cookieIssuer.issueCookiesWithRetry({
    username: account.username,
    password: account.password,
    otp_secret: account.otpSecret,
  })
  const openApiContext = await createRealOpenApiClient(cookies)

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
        recentTweetsPerAccount: CRAWL_LIMITS.recentTweetsPerAccount,
      },
      tweetId,
    )
    logger.info(
      `Manual tweet crawl complete for ${tweetId}: ${result.repliesFound} replies found, ${result.accountsProcessed} accounts processed`,
    )
  } finally {
    await closeRealOpenApiClient(openApiContext)
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
