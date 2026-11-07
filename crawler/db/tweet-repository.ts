import { Logger } from '@book000/node-utils'
import { Prisma, type PrismaClient, type Tweet } from '../generated/prisma'
import type { NormalizedTweet, NormalizedTweetSource } from 'twitter-client'

const logger = Logger.configure('tweet-repository')

export type TweetSource = NormalizedTweetSource
export type TweetInput = NormalizedTweet

export interface UpsertTweetResult {
  tweet: Tweet
  /** 新規作成、または AccountFeatureBundle.recentTweets が参照するフィールドが merge 後に変化したか。 */
  changed: boolean
}

// PK の形 (現在は (accountId, id)) に依存する箇所は、この 2 つに閉じ込める。
// PK が変わるときは、tweetKey と TWEET_CONFLICT_TARGET だけを書き換える。
// ID 単独の検索は PK の形に依存しないため、含めない。

function tweetKey(accountId: string, id: string) {
  return { accountId_id: { accountId, id } }
}

const TWEET_CONFLICT_TARGET = Prisma.sql`("accountId", "id")`

// 生 SQL の戻り値を Prisma の `Tweet` 型に合わせるための列。
export const TWEET_ROW_COLUMNS = Prisma.sql`
  "id"::text AS "id",
  "accountId"::text AS "accountId",
  "fullText",
  "createdAt",
  "retweetCount",
  "likeCount",
  "replyCount",
  "isReply",
  "conversationId"::text AS "conversationId",
  "inReplyToTweetId"::text AS "inReplyToTweetId",
  "isAuthorReply",
  "isRetweet",
  "isPromoted",
  "isPaidPromotion",
  COALESCE("expandedUrls", '{}') AS "expandedUrls",
  COALESCE("cardDestinationUrls", '{}') AS "cardDestinationUrls",
  "cardDestinationUrlsEvaluated",
  "hasMedia",
  "hasAiGeneratedMedia",
  "aiGeneratedDetectionSource",
  "quotedTweetAuthorId"::text AS "quotedTweetAuthorId",
  "quotedTweetHasVideo",
  "foreignVideoSourceCount",
  "collectedAt"
`

type TweetMergeBase = Pick<
  Tweet,
  | 'fullText'
  | 'createdAt'
  | 'retweetCount'
  | 'likeCount'
  | 'replyCount'
  | 'isReply'
  | 'conversationId'
  | 'isRetweet'
  | 'inReplyToTweetId'
  | 'isPromoted'
  | 'isPaidPromotion'
  | 'expandedUrls'
  | 'cardDestinationUrls'
  | 'cardDestinationUrlsEvaluated'
  | 'hasMedia'
  | 'hasAiGeneratedMedia'
  | 'aiGeneratedDetectionSource'
  | 'foreignVideoSourceCount'
  | 'quotedTweetAuthorId'
  | 'quotedTweetHasVideo'
>

/** merge 後に書き込む値。INSERT の値と、変化があったときの UPDATE の値を兼ねる。 */
export type TweetWriteValues = TweetMergeBase & Pick<Tweet, 'isAuthorReply'>

/**
 * 2 つの URL 配列が要素集合として異なるかを判定する。
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
 * @returns ラベル評価の入力に影響しうる変化があれば true
 */
function hasBundleRelevantChange(existing: TweetMergeBase, merged: TweetMergeBase): boolean {
  return (
    existing.fullText !== merged.fullText ||
    existing.createdAt.getTime() !== merged.createdAt.getTime() ||
    existing.retweetCount !== merged.retweetCount ||
    existing.likeCount !== merged.likeCount ||
    existing.isReply !== merged.isReply ||
    existing.conversationId !== merged.conversationId ||
    existing.isRetweet !== merged.isRetweet ||
    existing.inReplyToTweetId !== merged.inReplyToTweetId ||
    existing.isPromoted !== merged.isPromoted ||
    existing.isPaidPromotion !== merged.isPaidPromotion ||
    hasArrayChange(existing.expandedUrls, merged.expandedUrls) ||
    hasArrayChange(existing.cardDestinationUrls, merged.cardDestinationUrls) ||
    existing.cardDestinationUrlsEvaluated !== merged.cardDestinationUrlsEvaluated ||
    existing.hasMedia !== merged.hasMedia ||
    existing.hasAiGeneratedMedia !== merged.hasAiGeneratedMedia ||
    existing.aiGeneratedDetectionSource !== merged.aiGeneratedDetectionSource ||
    existing.foreignVideoSourceCount !== merged.foreignVideoSourceCount ||
    existing.quotedTweetAuthorId !== merged.quotedTweetAuthorId ||
    existing.quotedTweetHasVideo !== merged.quotedTweetHasVideo
  )
}

// 並びが入れ替わると同値の更新が書き込まれてしまうため、既存の並びの後ろに足す。
function unionUrls(existing: string[] | undefined, incoming: string[] | undefined): string[] {
  return [...new Set([...(existing ?? []), ...(incoming ?? [])])]
}

/**
 * 入力と既存行を merge した書き込み値を作る。
 * `isPromoted`/`isPaidPromotion` は既存値との OR で合成する: 単純に入力値で上書きすると、
 * 広告メタデータを含まない経路で再取得した際に、既に検出済みの `true` が `false` に戻ってしまう。
 * `hasAiGeneratedMedia` 系や引用ツイート関連のフィールドも、
 * `null` を「未評価」ではなく「上書きしてよい値」として扱うと既知の値を消してしまうため、
 * 入力値が `null` のときのみ既存値にフォールバックする。
 * @param input - 正規化済みのツイート
 * @param existing - 既存行。無ければ null
 * @returns 書き込む値。`isAuthorReply` は新規作成時だけ書かれ、既存行では更新されない
 */
export function mergeTweet(input: TweetInput, existing: TweetMergeBase | null): TweetWriteValues {
  return {
    fullText: input.fullText,
    createdAt: input.createdAt,
    retweetCount: input.retweetCount,
    likeCount: input.likeCount,
    replyCount: input.replyCount,
    isReply: input.isReply,
    isAuthorReply: input.isAuthorReply,
    conversationId: input.conversationId ?? existing?.conversationId ?? null,
    isRetweet: input.isRetweet,
    inReplyToTweetId: input.inReplyToTweetId,
    isPromoted: input.isPromoted || (existing?.isPromoted ?? false),
    isPaidPromotion: input.isPaidPromotion || (existing?.isPaidPromotion ?? false),
    expandedUrls: unionUrls(existing?.expandedUrls, input.expandedUrls),
    cardDestinationUrls: unionUrls(existing?.cardDestinationUrls, input.cardDestinationUrls),
    cardDestinationUrlsEvaluated:
      (input.cardDestinationUrlsEvaluated ?? false) ||
      (existing?.cardDestinationUrlsEvaluated ?? false),
    hasMedia:
      input.hasMedia === true || existing?.hasMedia === true
        ? true
        : input.hasMedia === false || existing?.hasMedia === false
          ? false
          : null,
    hasAiGeneratedMedia: input.hasAiGeneratedMedia ?? existing?.hasAiGeneratedMedia ?? null,
    aiGeneratedDetectionSource:
      input.aiGeneratedDetectionSource ?? existing?.aiGeneratedDetectionSource ?? null,
    foreignVideoSourceCount:
      input.foreignVideoSourceCount == null
        ? (existing?.foreignVideoSourceCount ?? null)
        : Math.max(input.foreignVideoSourceCount, existing?.foreignVideoSourceCount ?? 0),
    quotedTweetAuthorId: input.quotedTweetAuthorId ?? existing?.quotedTweetAuthorId ?? null,
    quotedTweetHasVideo: input.quotedTweetHasVideo ?? existing?.quotedTweetHasVideo ?? null,
  }
}

/**
 * Tweet を (accountId, id) で 1 行取得する。
 * @param prisma - Prisma クライアント
 * @param accountId - 投稿者の ID
 * @param id - ツイート ID
 * @returns 行。無ければ null
 */
export async function findTweet(
  prisma: PrismaClient,
  accountId: string,
  id: string,
): Promise<Tweet | null> {
  return prisma.tweet.findUnique({ where: tweetKey(accountId, id) })
}

// Prisma の upsert は空配列を NULL ではなく `{}` で書くため、生 SQL を使う。
async function writeTweet(
  prisma: PrismaClient,
  accountId: string,
  id: string,
  v: TweetWriteValues,
): Promise<Tweet | undefined> {
  const expandedUrls = v.expandedUrls.length === 0 ? null : v.expandedUrls
  const cardDestinationUrls = v.cardDestinationUrls.length === 0 ? null : v.cardDestinationUrls
  const rows = await prisma.$queryRaw<Tweet[]>(Prisma.sql`
    INSERT INTO "Tweet" AS t (
      "id", "accountId", "createdAt", "inReplyToTweetId", "conversationId", "quotedTweetAuthorId",
      "retweetCount", "likeCount", "replyCount", "foreignVideoSourceCount",
      "isReply", "isAuthorReply", "isRetweet", "isPromoted", "isPaidPromotion",
      "cardDestinationUrlsEvaluated", "hasMedia", "hasAiGeneratedMedia", "quotedTweetHasVideo",
      "aiGeneratedDetectionSource", "expandedUrls", "cardDestinationUrls", "fullText"
    ) VALUES (
      ${id}::bigint, ${accountId}::bigint, ${v.createdAt}::timestamptz,
      ${v.inReplyToTweetId}::bigint, ${v.conversationId}::bigint, ${v.quotedTweetAuthorId}::bigint,
      ${v.retweetCount}::int, ${v.likeCount}::int, ${v.replyCount}::int,
      ${v.foreignVideoSourceCount}::int,
      ${v.isReply}::boolean, ${v.isAuthorReply}::boolean, ${v.isRetweet}::boolean,
      ${v.isPromoted}::boolean, ${v.isPaidPromotion}::boolean,
      ${v.cardDestinationUrlsEvaluated}::boolean, ${v.hasMedia}::boolean,
      ${v.hasAiGeneratedMedia}::boolean, ${v.quotedTweetHasVideo}::boolean,
      ${v.aiGeneratedDetectionSource}::text, ${expandedUrls}::text[], ${cardDestinationUrls}::text[],
      ${v.fullText}::text
    )
    ON CONFLICT ${TWEET_CONFLICT_TARGET} DO UPDATE SET
      "createdAt" = EXCLUDED."createdAt",
      "inReplyToTweetId" = EXCLUDED."inReplyToTweetId",
      "conversationId" = EXCLUDED."conversationId",
      "quotedTweetAuthorId" = EXCLUDED."quotedTweetAuthorId",
      "retweetCount" = EXCLUDED."retweetCount",
      "likeCount" = EXCLUDED."likeCount",
      "replyCount" = EXCLUDED."replyCount",
      "foreignVideoSourceCount" = EXCLUDED."foreignVideoSourceCount",
      "isReply" = EXCLUDED."isReply",
      "isRetweet" = EXCLUDED."isRetweet",
      "isPromoted" = EXCLUDED."isPromoted",
      "isPaidPromotion" = EXCLUDED."isPaidPromotion",
      "cardDestinationUrlsEvaluated" = EXCLUDED."cardDestinationUrlsEvaluated",
      "hasMedia" = EXCLUDED."hasMedia",
      "hasAiGeneratedMedia" = EXCLUDED."hasAiGeneratedMedia",
      "quotedTweetHasVideo" = EXCLUDED."quotedTweetHasVideo",
      "aiGeneratedDetectionSource" = EXCLUDED."aiGeneratedDetectionSource",
      "expandedUrls" = EXCLUDED."expandedUrls",
      "cardDestinationUrls" = EXCLUDED."cardDestinationUrls",
      "fullText" = EXCLUDED."fullText"
    WHERE (
      t."createdAt", t."inReplyToTweetId", t."conversationId", t."quotedTweetAuthorId",
      t."retweetCount", t."likeCount", t."replyCount", t."foreignVideoSourceCount",
      t."isReply", t."isRetweet", t."isPromoted", t."isPaidPromotion",
      t."cardDestinationUrlsEvaluated", t."hasMedia", t."hasAiGeneratedMedia",
      t."quotedTweetHasVideo", t."aiGeneratedDetectionSource",
      COALESCE(t."expandedUrls", '{}'), COALESCE(t."cardDestinationUrls", '{}'), t."fullText"
    ) IS DISTINCT FROM (
      EXCLUDED."createdAt", EXCLUDED."inReplyToTweetId", EXCLUDED."conversationId",
      EXCLUDED."quotedTweetAuthorId", EXCLUDED."retweetCount", EXCLUDED."likeCount",
      EXCLUDED."replyCount", EXCLUDED."foreignVideoSourceCount", EXCLUDED."isReply",
      EXCLUDED."isRetweet", EXCLUDED."isPromoted", EXCLUDED."isPaidPromotion",
      EXCLUDED."cardDestinationUrlsEvaluated", EXCLUDED."hasMedia", EXCLUDED."hasAiGeneratedMedia",
      EXCLUDED."quotedTweetHasVideo", EXCLUDED."aiGeneratedDetectionSource",
      COALESCE(EXCLUDED."expandedUrls", '{}'), COALESCE(EXCLUDED."cardDestinationUrls", '{}'),
      EXCLUDED."fullText"
    )
    RETURNING ${TWEET_ROW_COLUMNS}
  `)
  return rows[0]
}

/**
 * Tweet を upsert し、ラベル評価に影響しうるフィールドが変化したかどうかも返す。
 * 既存行と値が同じなら UPDATE しない。
 * @param prisma - Prisma クライアント
 * @param input - 正規化済みのツイート
 * @returns upsert 後の Tweet と変化検知の結果
 */
export async function upsertTweet(
  prisma: PrismaClient,
  input: TweetInput,
): Promise<UpsertTweetResult> {
  const existing = await findTweet(prisma, input.accountId, input.id)
  const merged = mergeTweet(input, existing)
  const changed = existing === null || hasBundleRelevantChange(existing, merged)

  const written = await writeTweet(prisma, input.accountId, input.id, merged)
  if (written !== undefined) return { tweet: written, changed }
  const tweet = existing ?? (await findTweet(prisma, input.accountId, input.id))
  if (tweet === null) {
    throw new Error(`Tweet ${input.id} (accountId=${input.accountId}) vanished during upsert`)
  }
  return { tweet, changed }
}

// ツイートごとに個別に upsert する: 1 件の失敗 (一時的な DB エラーなど) で、
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

/** 直近ツイートの取得 SQL。実行計画のテストでも同じ文を使う。 */
export function recentTweetsQuery(accountIds: string[], limitPerAccount: number): Prisma.Sql {
  return Prisma.sql`
    SELECT t.*
    FROM UNNEST(${accountIds}::bigint[]) AS target("accountId")
    CROSS JOIN LATERAL (
      SELECT ${TWEET_ROW_COLUMNS}
      FROM "Tweet"
      WHERE "Tweet"."accountId" = target."accountId"
      ORDER BY "createdAt" DESC
      LIMIT ${limitPerAccount}
    ) t
  `
}

/**
 * 複数 account の直近ツイートを account ごとに `limitPerAccount` 件までまとめて 1 ラウンドトリップで取得する。
 * account ごとに `findMany` を発行する代わりに、`(accountId, createdAt)` 索引を使う `LATERAL JOIN` で account ごとの上位 N 件を 1 クエリに畳み込む。
 * @param prisma - Prisma クライアント
 * @param accountIds - 取得対象の account ID 一覧
 * @param limitPerAccount - account ごとに取得する直近ツイートの上限件数
 * @returns account ID から直近ツイート一覧 (作成日時降順) へのマップ
 */
export async function loadRecentTweetsForAccounts(
  prisma: PrismaClient,
  accountIds: string[],
  limitPerAccount: number,
): Promise<Map<string, Tweet[]>> {
  const tweetsByAccountId = new Map<string, Tweet[]>()
  if (accountIds.length === 0) return tweetsByAccountId

  const rows = await prisma.$queryRaw<Tweet[]>(recentTweetsQuery(accountIds, limitPerAccount))
  for (const row of rows) {
    const existing = tweetsByAccountId.get(row.accountId)
    if (existing) {
      existing.push(row)
    } else {
      tweetsByAccountId.set(row.accountId, [row])
    }
  }
  return tweetsByAccountId
}

/**
 * 複数 account の、指定時刻以降に投稿されたプロモーション付きツイートの件数を 1 ラウンドトリップで集計する。
 * @param prisma - Prisma クライアント
 * @param accountIds - 集計対象の account ID 一覧
 * @param since - この時刻以降に投稿されたツイートのみを数える
 * @returns account ID から件数へのマップ。該当ツイートが無い account はキーを持たない
 */
export async function loadPromotedTweetCountsForAccounts(
  prisma: PrismaClient,
  accountIds: string[],
  since: Date,
): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  if (accountIds.length === 0) return counts

  const rows = await prisma.$queryRaw<{ accountId: string; count: number }[]>`
    SELECT "accountId"::text AS "accountId", COUNT(*)::int AS "count"
    FROM "Tweet"
    WHERE "accountId" = ANY(${accountIds}::bigint[])
      AND "isPromoted" = true
      AND "createdAt" >= ${since}
    GROUP BY "accountId"
  `
  for (const row of rows) counts.set(row.accountId, row.count)
  return counts
}

// 以下の ID 単独の検索は、投稿者が分からない親ツイートの引き当て用で、件数の少ないバッチに限る。

/**
 * @param prisma - Prisma クライアント
 * @param ids - 存在確認したい Tweet ID の一覧
 * @returns `ids` のうち `Tweet` テーブルにまだ存在しないものだけを抽出した一覧
 */
export async function findMissingTweetIds(prisma: PrismaClient, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const existing = await prisma.tweet.findMany({
    where: { id: { in: ids } },
    select: { id: true },
  })
  const existingIds = new Set(existing.map((row) => row.id))
  return ids.filter((id) => !existingIds.has(id))
}

/**
 * @param prisma - Prisma クライアント
 * @param ids - 本文を取得したい Tweet ID の一覧
 * @returns 存在する Tweet の id をキー、fullText を値とする Map。存在しない id は含まない
 */
export async function findTweetTextsByIds(
  prisma: PrismaClient,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.tweet.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullText: true },
  })
  return new Map(rows.map((row) => [row.id, row.fullText]))
}

export interface TweetContext {
  fullText: string
  accountId: string
}

/**
 * parent reply classification 用に本文と投稿者を1回の問い合わせで取得する。
 */
export async function findTweetContextsByIds(
  prisma: PrismaClient,
  ids: string[],
): Promise<Map<string, TweetContext>> {
  if (ids.length === 0) return new Map()
  const rows = await prisma.tweet.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullText: true, accountId: true },
  })
  return new Map(rows.map((row) => [row.id, { fullText: row.fullText, accountId: row.accountId }]))
}
