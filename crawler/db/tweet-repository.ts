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
  // `isPromoted`/`isPaidPromotion` は既存値との OR で合成する: 単純に入力値で上書きすると、
  // 広告メタデータを含まない経路で再取得した際に、
  // 既に検出済みの `true` が `false` に戻ってしまう。
  // 同様の問題は `crawler/twitter/mappers.ts` の `mergeTweetAdFlags` でも扱っている。
  // `hasAiGeneratedMedia` 系や引用ツイート関連のフィールドも、
  // `null` を「未評価」ではなく「上書きしてよい値」として扱うと既知の値を消してしまうため、
  // 入力値が `null` のときのみ既存値にフォールバックする (詳細は該当マイグレーション参照)。
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

// ツイートごとに個別に upsert する: 1 件の失敗 (未永続化の account FK や一時的な DB エラーなど) で、
// バッチ内の後続ツイートまで巻き込んで永続化を止めてはならないため。
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
