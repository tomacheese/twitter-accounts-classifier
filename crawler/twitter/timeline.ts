import type {
  TimelineApiUtilsResponse,
  TweetApiUtils,
  TweetApiUtilsData,
  TwitterApiUtilsResponse,
} from 'twitter-openapi-typescript'
import {
  toAccountProfileInput,
  toTweetInput,
  type RawTweetResult,
  type RawUserResult,
} from './mappers'
import type { AccountProfileInput } from '../db/account-repository'
import type { TweetInput } from '../db/tweet-repository'

/**
 * `rawCount` を `data.data` とは別に持つのは、全件が広告・tombstone などで
 * フィルタされ 0 件になったページと、データが尽きたページを `data.data` だけでは
 * 区別できないため。
 */
export interface TimelinePage {
  data: { data: RawTweetResult[]; cursor?: string; rawCount: number }
}

export interface TweetApiLike {
  getHomeTimeline(param: { count?: number; cursor?: string }): Promise<TimelinePage>
  getHomeLatestTimeline(param: { count?: number; cursor?: string }): Promise<TimelinePage>
  getSearchTimeline(param: {
    rawQuery: string
    product?: 'Top' | 'Latest'
    count?: number
    cursor?: string
  }): Promise<TimelinePage>
}

export interface TrendsScraperLike {
  getTrends(): Promise<string[]>
}

export interface TimelineResult {
  tweets: TweetInput[]
  /** アカウントごとに追加 API 呼び出しをして取得する代わりに、同一レスポンスから導出したプロフィール。アカウント情報を別途取得できなかった場合の代替として利用できる。 */
  authors: AccountProfileInput[]
}

function mapEach(
  raw: RawTweetResult[],
  source: 'recommended' | 'following' | 'trending',
): TimelineResult {
  // isAuthorReply はトップレベルのタイムラインエントリには適用されないため、
  // viewerAccountId には空文字のダミー値を渡している。
  return {
    tweets: raw.map((tweet) => toTweetInput(tweet, { source, viewerAccountId: '' })),
    authors: raw.map((tweet) => toAccountProfileInput(tweet.user)),
  }
}

/**
 * カーソルが壊れて同じ値を繰り返し返し続けた場合の保険としてすでに同一カーソル
 * 検知を入れているが、それだけに頼らず無条件の上限も設けている。
 */
const MAX_PAGES_PER_TIMELINE = 50

/**
 * ホームタイムライン・検索エンドポイントは広告混在やアルゴリズムの都合で
 * 1 回の呼び出しでは `count` まで埋まらないことがあるため、`limit` に達するか
 * カーソルが尽きるまで呼び出しを繰り返す。
 *
 * マッピング後の件数が 0 件のページでも、`rawCount` が正でカーソルが残っていれば
 * データ終端とは限らないため、そのまま次のページを取得し続ける。カーソルが
 * 同じ値のまま進まない場合や {@link MAX_PAGES_PER_TIMELINE} に達した場合は、
 * `rawCount` やカーソル判定が効かないケースへの保険として、強制的にループを止める。
 * @param fetchPage - fetches one page for a given cursor (`undefined` for the first page)
 * @param limit - the maximum number of tweets to collect
 * @returns the collected tweets, truncated to `limit`
 */
async function paginateTimeline(
  fetchPage: (cursor: string | undefined) => Promise<TimelinePage>,
  limit: number,
): Promise<RawTweetResult[]> {
  const tweets: RawTweetResult[] = []
  let cursor: string | undefined
  let pages = 0

  while (tweets.length < limit && pages < MAX_PAGES_PER_TIMELINE) {
    const response = await fetchPage(cursor)
    tweets.push(...response.data.data)
    pages++

    const nextCursor = response.data.cursor
    if (!nextCursor || response.data.rawCount === 0 || nextCursor === cursor) {
      break
    }
    cursor = nextCursor
  }

  return tweets.slice(0, limit)
}

/**
 * @param client - the tweet API adapter
 * @param limit - the maximum number of tweets to collect
 * @returns the collected tweets and their authors' profiles
 */
export async function fetchRecommendedTimeline(
  client: TweetApiLike,
  limit: number,
): Promise<TimelineResult> {
  const raw = await paginateTimeline(
    (cursor) => client.getHomeTimeline({ count: limit, cursor }),
    limit,
  )
  return mapEach(raw, 'recommended')
}

/**
 * @param client - the tweet API adapter
 * @param limit - the maximum number of tweets to collect
 * @returns the collected tweets and their authors' profiles
 */
export async function fetchFollowingTimeline(
  client: TweetApiLike,
  limit: number,
): Promise<TimelineResult> {
  const raw = await paginateTimeline(
    (cursor) => client.getHomeLatestTimeline({ count: limit, cursor }),
    limit,
  )
  return mapEach(raw, 'following')
}

/**
 * トレンドごとに独立してページングするため、この関数全体で発行される API 呼び出し
 * 回数は `maxTrends` にほぼ比例する。トレンドごとの検索結果は少ないページ数で
 * 収まることが多く、許容できると判断している。
 * @param scraper - fetches the current trend names
 * @param client - the tweet API adapter
 * @param limitPerTrend - the maximum number of tweets to collect per trend
 * @param maxTrends - the maximum number of trends to consult
 * @returns the collected tweets (across all consulted trends) and their authors' profiles
 */
export async function fetchTrendingTimeline(
  scraper: TrendsScraperLike,
  client: TweetApiLike,
  limitPerTrend: number,
  maxTrends: number,
): Promise<TimelineResult> {
  const allTrends = await scraper.getTrends()
  const trends = allTrends.slice(0, maxTrends)
  const tweets: TweetInput[] = []
  const authors: AccountProfileInput[] = []

  for (const trend of trends) {
    const raw = await paginateTimeline(
      (cursor) =>
        client.getSearchTimeline({ rawQuery: trend, product: 'Top', count: limitPerTrend, cursor }),
      limitPerTrend,
    )
    const mapped = mapEach(raw, 'trending')
    tweets.push(...mapped.tweets)
    authors.push(...mapped.authors)
  }

  return { tweets, authors }
}

/**
 * `screenName`・`name`・`createdAt` は X の実レスポンスでは `user.core` 側に
 * 移っており、`legacy` 側の同名フィールドは省略されることが一般的なため、
 * `legacy` 単独の型では値を取りこぼす。`user.core` を優先し、古い・異なる形状の
 * レスポンスに備えて `legacy` をフォールバックとして読む。`verifiedType` も
 * 同様に `RawUserResult` が想定するトップレベルではなく
 * `user.verification?.verifiedType` に存在するため変換が必要になる。
 * `./profile` の `createUserApiLike` からも同じ形状の変換として再利用される。
 * @param user - a user object as returned inside a real timeline/user API response
 * @returns the same user in the `RawUserResult` shape
 */
export function toRawUserResult(user: TweetApiUtilsData['user']): RawUserResult {
  return {
    restId: user.restId,
    legacy: {
      screenName: user.core?.screenName ?? user.legacy.screenName ?? '',
      name: user.core?.name ?? user.legacy.name ?? '',
      description: user.legacy.description,
      followersCount: user.legacy.followersCount,
      friendsCount: user.legacy.friendsCount,
      statusesCount: user.legacy.statusesCount,
      createdAt: user.core?.createdAt ?? user.legacy.createdAt ?? '',
      profileImageUrlHttps: user.legacy.profileImageUrlHttps ?? null,
      location: user.legacy.location ?? null,
      url: user.legacy.url ?? null,
    },
    isBlueVerified: user.isBlueVerified,
    verifiedType: user.verification?.verifiedType ?? null,
    professionalType: user.professional?.professionalType ?? null,
    parodyCommentaryFanLabel: user.parodyCommentaryFanLabel ?? null,
  }
}

/**
 * `legacy` を持たないエントリ (tombstone・非表示のツイートなど) はテキストや
 * エンゲージメント件数を持たないため `null` を返し、マッピング対象から除外する。
 *
 * `retweetedStatusIdStr` は実際の `TweetLegacy` 型には存在せず、リツイートは
 * `TweetApiUtilsData.retweeted` がリツイート元エントリ全体を保持する形で表現
 * されるため、そこから id を読み出す。引用ツイートも同じ形状で
 * `TweetApiUtilsData.quoted` に保持され、その `legacy` も欠落し得るため、
 * 常に存在する前提を置かず欠落時は `undefined` のままにしている。
 * @param data - one real timeline entry
 * @returns the entry as a `RawTweetResult`, or `null` if it carries no `legacy` payload
 */
function toRawTweetResult(data: TweetApiUtilsData): RawTweetResult | null {
  if (!data.tweet.legacy) return null

  return {
    restId: data.tweet.restId,
    legacy: {
      fullText: data.tweet.legacy.fullText,
      createdAt: data.tweet.legacy.createdAt,
      retweetCount: data.tweet.legacy.retweetCount,
      favoriteCount: data.tweet.legacy.favoriteCount,
      replyCount: data.tweet.legacy.replyCount,
      quoteCount: data.tweet.legacy.quoteCount,
      inReplyToStatusIdStr: data.tweet.legacy.inReplyToStatusIdStr ?? null,
      retweetedStatusIdStr: data.retweeted?.tweet.restId ?? null,
      extendedEntities: data.tweet.legacy.extendedEntities,
      quotedStatusResult: data.quoted
        ? {
            result: {
              restId: data.quoted.tweet.restId,
              legacy: data.quoted.tweet.legacy
                ? { extendedEntities: data.quoted.tweet.legacy.extendedEntities }
                : undefined,
              user: { restId: data.quoted.user.restId },
            },
          }
        : null,
      isPromoted: Boolean(data.promotedMetadata),
      isPaidPromotion:
        data.tweet.contentDisclosure?.advertisingDisclosure?.isPaidPromotion ?? false,
      // contentDisclosure.aiGeneratedDisclosure が欠落している場合は false に
      // 丸めず null (未評価) のままにしている。X がこの情報を常に付与するとは
      // 限らず、欠落が「AI 生成ではない」を意味するとは断定できないため。
      hasAiGeneratedMedia:
        data.tweet.contentDisclosure?.aiGeneratedDisclosure?.hasAiGeneratedMedia ?? null,
      aiGeneratedDetectionSource:
        data.tweet.contentDisclosure?.aiGeneratedDisclosure?.aiGeneratedDetectionSource ?? null,
    },
    user: toRawUserResult(data.user),
  }
}

function toRawTweetResults(data: TweetApiUtilsData[]): RawTweetResult[] {
  return data
    .map((entry) => toRawTweetResult(entry))
    .filter((tweet): tweet is RawTweetResult => tweet !== null)
}

/**
 * `./engagement` の `TweetDetailApiLike` が `TweetApiUtils.getTweetDetail` をラップ
 * する際にもこの関数を再利用している。`getTweetDetail` のレスポンスも同じ
 * `TwitterApiUtilsResponse<TimelineApiUtilsResponse<TweetApiUtilsData>>` 形状のため。
 * @param response - the pending API response
 * @returns the converted page
 */
export async function convertTimelineResponse(
  response: Promise<TwitterApiUtilsResponse<TimelineApiUtilsResponse<TweetApiUtilsData>>>,
): Promise<TimelinePage> {
  const result = await response
  return {
    data: {
      data: toRawTweetResults(result.data.data),
      cursor: result.data.cursor.bottom?.value,
      rawCount: result.data.data.length,
    },
  }
}

/**
 * @param tweetApi - the real tweet API, e.g. from `TwitterOpenApiClient.getTweetApi()`
 * @returns a `TweetApiLike` usable with {@link fetchRecommendedTimeline}, {@link fetchFollowingTimeline}, and {@link fetchTrendingTimeline}
 */
export function createTweetApiLike(tweetApi: TweetApiUtils): TweetApiLike {
  return {
    getHomeTimeline: (param) => convertTimelineResponse(tweetApi.getHomeTimeline(param)),
    getHomeLatestTimeline: (param) =>
      convertTimelineResponse(tweetApi.getHomeLatestTimeline(param)),
    getSearchTimeline: (param) => convertTimelineResponse(tweetApi.getSearchTimeline(param)),
  }
}
