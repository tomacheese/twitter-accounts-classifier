import { Logger } from '@book000/node-utils'
import type { PrismaClient, Tweet } from '../generated/prisma'
import type { NormalizedTweet, NormalizedTweetSource } from 'twitter-client'

const logger = Logger.configure('tweet-repository')

export type TweetSource = NormalizedTweetSource
export type TweetInput = NormalizedTweet

export interface UpsertTweetResult {
  tweet: Tweet
  /** 新規作成、または AccountFeatureBundle.recentTweets が参照するフィールドが merge 後に変化したか。 */
  changed: boolean
}

// AccountFeatureBundle.recentTweets が参照するフィールドのうち、
// DB の既存値と比較して変化検知の対象にするもの。
interface ExistingTweetSnapshot {
  fullText: string
  createdAt: Date
  retweetCount: number
  likeCount: number
  isReply: boolean
  isRetweet: boolean
  inReplyToTweetId: string | null
  isPromoted: boolean
  isPaidPromotion: boolean
  expandedUrls: string[]
  hasAiGeneratedMedia: boolean | null
  aiGeneratedDetectionSource: string | null
  foreignVideoSourceCount: number | null
  quotedTweetId: string | null
  quotedTweetAuthorId: string | null
  quotedTweetHasVideo: boolean | null
}

/**
 * 2 つの URL 配列が要素集合として一致するかを判定する。
 * @param a - 比較対象の配列
 * @param b - 比較対象の配列
 * @returns 要素の集合が異なれば true
 */
function hasArrayChange(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return true
  const bSet = new Set(b)
  return a.some((value) => !bSet.has(value))
}

/**
 * merge 後の値が既存行と異なるかを判定する。
 * @param existing - 更新前の既存行
 * @param merged - merge 後に書き込む値
 * @returns 変化があれば true
 */
function hasBundleRelevantChange(
  existing: ExistingTweetSnapshot,
  merged: ExistingTweetSnapshot,
): boolean {
  return (
    existing.fullText !== merged.fullText ||
    existing.createdAt.getTime() !== merged.createdAt.getTime() ||
    existing.retweetCount !== merged.retweetCount ||
    existing.likeCount !== merged.likeCount ||
    existing.isReply !== merged.isReply ||
    existing.isRetweet !== merged.isRetweet ||
    existing.inReplyToTweetId !== merged.inReplyToTweetId ||
    existing.isPromoted !== merged.isPromoted ||
    existing.isPaidPromotion !== merged.isPaidPromotion ||
    hasArrayChange(existing.expandedUrls, merged.expandedUrls) ||
    existing.hasAiGeneratedMedia !== merged.hasAiGeneratedMedia ||
    existing.aiGeneratedDetectionSource !== merged.aiGeneratedDetectionSource ||
    existing.foreignVideoSourceCount !== merged.foreignVideoSourceCount ||
    existing.quotedTweetAuthorId !== merged.quotedTweetAuthorId ||
    existing.quotedTweetHasVideo !== merged.quotedTweetHasVideo
  )
}

/**
 * Tweet を upsert し、ラベル評価に影響しうるフィールドが変化したかどうかも返す。
 * @param prisma - Prisma クライアント
 * @param input - 正規化済みのツイート
 * @returns upsert 後の Tweet と変化検知の結果
 */
export async function upsertTweet(
  prisma: PrismaClient,
  input: TweetInput,
): Promise<UpsertTweetResult> {
  // `isPromoted`/`isPaidPromotion` は既存値との OR で合成する: 単純に入力値で上書きすると、
  // 広告メタデータを含まない経路で再取得した際に、
  // 既に検出済みの `true` が `false` に戻ってしまう。
  // 同様の問題は `twitter-client` の `mergeTweetAdFlags` でも扱っている。
  // `hasAiGeneratedMedia` 系や引用ツイート関連のフィールドも、
  // `null` を「未評価」ではなく「上書きしてよい値」として扱うと既知の値を消してしまうため、
  // 入力値が `null` のときのみ既存値にフォールバックする(詳細は該当マイグレーション参照)。
  const existing = await prisma.tweet.findUnique({
    where: { id: input.id },
    select: {
      fullText: true,
      createdAt: true,
      retweetCount: true,
      likeCount: true,
      isReply: true,
      isRetweet: true,
      inReplyToTweetId: true,
      isPromoted: true,
      isPaidPromotion: true,
      expandedUrls: true,
      hasAiGeneratedMedia: true,
      aiGeneratedDetectionSource: true,
      foreignVideoSourceCount: true,
      quotedTweetId: true,
      quotedTweetAuthorId: true,
      quotedTweetHasVideo: true,
    },
  })

  const mergedUpdate = {
    fullText: input.fullText,
    createdAt: input.createdAt,
    retweetCount: input.retweetCount,
    likeCount: input.likeCount,
    replyCount: input.replyCount,
    quoteCount: input.quoteCount,
    isReply: input.isReply,
    isRetweet: input.isRetweet,
    inReplyToTweetId: input.inReplyToTweetId,
    isPromoted: input.isPromoted || (existing?.isPromoted ?? false),
    isPaidPromotion: input.isPaidPromotion || (existing?.isPaidPromotion ?? false),
    expandedUrls: [...new Set([...(input.expandedUrls ?? []), ...(existing?.expandedUrls ?? [])])],
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
  }

  const changed = existing === null || hasBundleRelevantChange(existing, mergedUpdate)

  const tweet = await prisma.tweet.upsert({
    where: { id: input.id },
    create: input,
    update: mergedUpdate,
  })

  return { tweet, changed }
}

// ツイートごとに個別に upsert する: 1 件の失敗 (account FK 未永続化や一時的な DB エラー) で、
// バッチ内の後続ツイートまで巻き込んで永続化を止めてはならないため。
export async function upsertTweets(
  prisma: PrismaClient,
  inputs: TweetInput[],
): Promise<UpsertTweetResult[]> {
  const results: UpsertTweetResult[] = []
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
