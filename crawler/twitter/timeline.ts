import type {
  TimelineApiUtilsResponse,
  TweetApiUtils,
  TweetApiUtilsData,
  TwitterApiUtilsResponse,
} from 'twitter-openapi-typescript'
import type { AccountProfileInput } from '../db/account-repository'
import type { TweetInput } from '../db/tweet-repository'
import {
  toAccountProfileInput,
  toTweetInput,
  type RawTweetResult,
  type RawUserResult,
  type TrendsScraperLike,
} from 'twitter-client'

/**
 * `rawCount` を `data.data` とは別に持つのは、
 * 広告や tombstone などで全件がフィルタされ 0 件になったページと、
 * データが尽きたページを `data.data` だけでは区別できないため。
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

export interface TimelineResult {
  tweets: TweetInput[]
  /**
   * アカウントごとに追加 API 呼び出しをする代わりに、同一レスポンスから導出したプロフィール。
   * アカウント情報を別途取得できなかった場合の代替として使える。
   */
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
 * カーソルが同じ値を繰り返し返す場合の保険として、すでに同一カーソル検知を入れているが、
 * それだけに頼らず無条件の上限も設けている。
 */
const MAX_PAGES_PER_TIMELINE = 50

/**
 * ホームタイムライン・検索は広告混在等で 1 回の呼び出しでは `count` まで埋まらないことがあるため、
 * `limit` に達するかカーソルが尽きるまで呼び出しを繰り返す。
 *
 * マッピング後の件数が 0 件でも、`rawCount` が正でカーソルが残ればデータ終端とは限らないため、
 * そのまま次のページを取得し続ける。
 * カーソルが同じ値のまま進まない場合や {@link MAX_PAGES_PER_TIMELINE} に達した場合は、
 * `rawCount` やカーソル判定が効かないケースへの保険として、強制的にループを止める。
 * @param fetchPage - 指定カーソルに対応する 1 ページを取得する関数 (先頭ページは `undefined`)
 * @param limit - 収集するツイートの最大件数
 * @returns 収集したツイート (`limit` 件に切り詰め済み)
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
 * @param client - ツイート API アダプター
 * @param limit - 収集するツイートの最大件数
 * @returns 収集したツイートとその投稿者のプロフィール
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
 * @param client - ツイート API アダプター
 * @param limit - 収集するツイートの最大件数
 * @returns 収集したツイートとその投稿者のプロフィール
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
 * トレンドごとに独立してページングするため、
 * この関数全体で発行される API 呼び出し回数は `maxTrends` にほぼ比例する。
 * トレンドごとの検索結果は少ないページ数で収まることが多く、許容できると判断している。
 * @param scraper - 現在のトレンド名を取得する
 * @param client - ツイート API アダプター
 * @param limitPerTrend - トレンドごとに収集するツイートの最大件数
 * @param maxTrends - 参照するトレンドの最大件数
 * @returns 参照した全トレンドを合わせて収集したツイートとその投稿者のプロフィール
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
 * `screenName`・`name`・`createdAt` は X の実レスポンスでは `user.core` 側に移っており、
 * `legacy` 側の同名フィールドは省略されることが一般的なため、
 * `legacy` 単独の型では値を取りこぼす。
 * `user.core` を優先し、
 * 古い・異なる形状のレスポンスに備えて `legacy` をフォールバックとして読む。
 * `verifiedType` も同様、`user.verification?.verifiedType` に存在するため変換が必要になる。
 * `./profile` の `createUserApiLike` からも同じ形状の変換として再利用される。
 * @param user - 実際のタイムライン・ユーザー API レスポンス内に含まれるユーザーオブジェクト
 * @returns 同じユーザーを `RawUserResult` 形状に変換したもの
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
 * `legacy` のないエントリ (tombstone 等) はテキストや件数を持たないため `null` を返し、
 * マッピング対象から除外する。
 *
 * `retweetedStatusIdStr` は実際の `TweetLegacy` 型には存在せず、
 * リツイートは `TweetApiUtilsData.retweeted` がリツイート元全体を保持する形で表現されるため、
 * そこから id を読み出す。
 * 引用ツイートも同じ形状で `TweetApiUtilsData.quoted` に保持され、
 * その `legacy` も欠落し得るため、
 * 常に存在する前提を置かず欠落時は `undefined` のままにしている。
 * @param data - 実際のタイムラインエントリ 1 件分
 * @returns `RawTweetResult` に変換したエントリ、`legacy` を持たない場合は `null`
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
      entities: data.tweet.legacy.entities
        ? {
            urls: data.tweet.legacy.entities.urls?.map((entry) => ({
              url: entry.url,
              expandedUrl: entry.expandedUrl,
            })),
          }
        : undefined,
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
      // contentDisclosure.aiGeneratedDisclosure 欠落時は false でなく null (未評価) にする。
      // X がこの情報を常に付与するとは限らず、
      // 欠落が「AI 生成ではない」を意味するとは断定できないため。
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
 * `getTweetDetail` の応答も下記と同じ `TimelineApiUtilsResponse<TweetApiUtilsData>` 形状のため、
 * `./engagement` の `TweetDetailApiLike` もラップ時にこの関数を再利用している。
 * @param response - 保留中の API レスポンス
 * @returns 変換後のページ
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
 * @param tweetApi - 実際のツイート API (例: `TwitterOpenApiClient.getTweetApi()`)
 * @returns 各 timeline 取得関数 (Recommended/Following/Trending) が共通して使う `TweetApiLike`
 */
export function createTweetApiLike(tweetApi: TweetApiUtils): TweetApiLike {
  return {
    getHomeTimeline: (param) => convertTimelineResponse(tweetApi.getHomeTimeline(param)),
    getHomeLatestTimeline: (param) =>
      convertTimelineResponse(tweetApi.getHomeLatestTimeline(param)),
    getSearchTimeline: (param) => convertTimelineResponse(tweetApi.getSearchTimeline(param)),
  }
}
