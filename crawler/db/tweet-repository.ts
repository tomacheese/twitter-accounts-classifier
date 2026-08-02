import { Logger } from '@book000/node-utils'
import type { PrismaClient, Tweet } from '../generated/prisma'

const logger = Logger.configure('tweet-repository')

export type TweetSource = 'recommended' | 'following' | 'trending' | 'profile' | 'manual'

export interface TweetInput {
  id: string
  accountId: string
  fullText: string
  createdAt: Date
  retweetCount: number
  likeCount: number
  replyCount: number
  quoteCount: number
  isReply: boolean
  inReplyToTweetId: string | null
  isAuthorReply: boolean
  isRetweet: boolean
  retweetedTweetId: string | null
  isPromoted: boolean
  isPaidPromotion: boolean
  hasAiGeneratedMedia: boolean | null
  aiGeneratedDetectionSource: string | null
  foreignVideoSourceCount?: number | null
  quotedTweetId: string | null
  quotedTweetAuthorId: string | null
  quotedTweetHasVideo: boolean | null
  source: TweetSource
}

export async function upsertTweet(prisma: PrismaClient, input: TweetInput): Promise<Tweet> {
  // The same tweet can be re-observed across separate crawl cycles through different fetch
  // paths, and only some of those paths carry the ad-disclosure metadata needed to detect
  // `isPromoted`/`isPaidPromotion` (see `mergeTweetAdFlags` in crawler/twitter/mappers.ts,
  // which handles the equivalent problem for duplicates observed within a single crawl
  // batch). Without OR-ing against the row's existing value here, a later re-crawl that
  // simply doesn't see the ad metadata this time would silently flip a previously-detected
  // `true` back to `false`. `hasAiGeneratedMedia`/`aiGeneratedDetectionSource` have the same
  // problem in a different shape: `null` means "not evaluated this fetch", not "confirmed
  // absent", so a later re-crawl observing `null` must not erase an already-known value.
  // `quotedTweetId`/`quotedTweetAuthorId`/`quotedTweetHasVideo` follow the same
  // "null = not evaluated this fetch" convention (see the migration for detail).
  const existing = await prisma.tweet.findUnique({
    where: { id: input.id },
    select: {
      isPromoted: true,
      isPaidPromotion: true,
      hasAiGeneratedMedia: true,
      aiGeneratedDetectionSource: true,
      foreignVideoSourceCount: true,
      quotedTweetId: true,
      quotedTweetAuthorId: true,
      quotedTweetHasVideo: true,
    },
  })

  return prisma.tweet.upsert({
    where: { id: input.id },
    create: input,
    update: {
      fullText: input.fullText,
      retweetCount: input.retweetCount,
      likeCount: input.likeCount,
      replyCount: input.replyCount,
      quoteCount: input.quoteCount,
      isPromoted: input.isPromoted || (existing?.isPromoted ?? false),
      isPaidPromotion: input.isPaidPromotion || (existing?.isPaidPromotion ?? false),
      hasAiGeneratedMedia: input.hasAiGeneratedMedia ?? existing?.hasAiGeneratedMedia ?? null,
      aiGeneratedDetectionSource:
        input.aiGeneratedDetectionSource ?? existing?.aiGeneratedDetectionSource ?? null,
      foreignVideoSourceCount:
        input.foreignVideoSourceCount == null
          ? (existing?.foreignVideoSourceCount ?? null)
          : Math.max(input.foreignVideoSourceCount, existing?.foreignVideoSourceCount ?? 0),
      quotedTweetId: input.quotedTweetId ?? existing?.quotedTweetId ?? null,
      quotedTweetAuthorId: input.quotedTweetAuthorId ?? existing?.quotedTweetAuthorId ?? null,
      quotedTweetHasVideo: input.quotedTweetHasVideo ?? existing?.quotedTweetHasVideo ?? null,
      source: input.source,
    },
  })
}

// Each tweet is upserted independently: a single failure (e.g. an as-yet-unpersisted
// account FK, or a transient DB error) must not silently drop every tweet that follows it
// in the batch. A real case was traced to exactly this - a batch containing tweets for many
// accounts across one crawl cycle threw partway through, and everything after the failing
// tweet was never persisted even though it had already been used to compute that account's
// labels from the in-memory bundle, producing labels with no corresponding persisted tweets.
export async function upsertTweets(prisma: PrismaClient, inputs: TweetInput[]): Promise<Tweet[]> {
  const results: Tweet[] = []
  for (const input of inputs) {
    try {
      results.push(await upsertTweet(prisma, input))
    } catch (error) {
      logger.error(
        `Failed to upsert tweet ${input.id} (accountId=${input.accountId})`,
        error as Error,
      )
    }
  }
  return results
}
