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
 * A single timeline API response page: its mapped tweets, the cursor to pass to fetch the
 * next page (if any), and `rawCount` - the entry count *before* {@link toRawTweetResult}
 * filtering. `rawCount` is required because a page can filter down to zero mappable tweets
 * (e.g. an all-ads/all-tombstoned page) while a valid next cursor still exists; `data.data`
 * alone can't tell that case apart from a genuinely empty (end-of-data) page.
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
  /** Profiles of every tweet author appearing in the response, derived from the same data (no extra API calls). Callers can use this as a fallback Account row source if a dedicated profile fetch for that author later fails, e.g. a suspended account. */
  authors: AccountProfileInput[]
}

function mapEach(
  raw: RawTweetResult[],
  source: 'recommended' | 'following' | 'trending',
): TimelineResult {
  // viewerAccountId only matters for deciding isAuthorReply, which never applies to
  // top-level timeline entries, so an empty-string sentinel is passed here.
  return {
    tweets: raw.map((tweet) => toTweetInput(tweet, { source, viewerAccountId: '' })),
    authors: raw.map((tweet) => toAccountProfileInput(tweet.user)),
  }
}

/**
 * Hard cap on the number of pages {@link paginateTimeline} will fetch for a single call,
 * regardless of `limit`. Guards against an unbounded loop if the API ever returns a cursor
 * that never resolves to genuinely-exhausted data (e.g. a buggy/looping cursor) - the
 * same-cursor check below should already catch a stuck cursor, but this is a second,
 * unconditional backstop.
 */
const MAX_PAGES_PER_TIMELINE = 50

/**
 * Repeatedly calls `fetchPage` with the cursor returned by the previous call, collecting
 * tweets until `limit` have been collected, the cursor is exhausted, or the raw (pre-filter)
 * page comes back empty (mirrors `./follows.ts`'s `paginate`). X's home-timeline/search
 * endpoints don't reliably fill a single page up to the requested `count` (ads/algorithm
 * mixing, and entries without `legacy` are dropped before reaching here), so one call alone
 * under-fetches even when `count` equals `limit`.
 *
 * Pagination continues past a page whose *mapped* tweets are empty as long as `rawCount` is
 * still positive and a next cursor is present - an all-ads/all-tombstoned page is not the
 * same as end-of-data. A repeated cursor (no progress) or {@link MAX_PAGES_PER_TIMELINE}
 * stops the loop regardless, in case `rawCount`/cursor exhaustion isn't reliably signalled.
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
 * Fetches the algorithmic "recommended" home timeline, paginating via cursor until either
 * the cursor is exhausted or `limit` tweets have been collected (see {@link paginateTimeline}).
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
 * Fetches the reverse-chronological "following" (home-latest) timeline, paginating via
 * cursor until either the cursor is exhausted or `limit` tweets have been collected (see
 * {@link paginateTimeline}).
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
 * Fetches the current trends, then for each (up to `maxTrends`) searches its top tweets,
 * paginating each trend's search via cursor until either the cursor is exhausted or
 * `limitPerTrend` tweets have been collected for that trend (see {@link paginateTimeline}).
 * Each trend is paginated independently, so the total number of API calls this function
 * makes is bounded by `maxTrends` times the number of pages needed per trend - acceptable
 * here because per-trend search results are typically only a few pages even at
 * `limitPerTrend` around 100 (see `crawl-limits.ts`).
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
 * Converts a `twitter-openapi-typescript-generated` user (as returned inside
 * `TweetApiUtilsData.user`) into the `RawUserResult` shape `./mappers` expects.
 * `verifiedType` lives at `user.verification?.verifiedType` in the real model, not as a
 * top-level field as `RawUserResult` assumes. Exported because `./profile`'s
 * `createUserApiLike` reuses it to convert `UserApiUtilsData.user`, which has the same
 * `TweetApiUtilsData['user']` shape.
 *
 * `screenName`/`name`/`createdAt` moved to the separate `user.core` object in X's live
 * responses, where `legacy`'s copies are optional and consistently absent; `legacy` is
 * still read as a fallback for older/differently-shaped responses.
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
 * Converts one real timeline entry (`TweetApiUtilsData`) into `RawTweetResult`.
 * Returns `null` for entries without `legacy` (e.g. tombstoned/withheld tweets), which
 * carry no text/engagement counts to map.
 *
 * `retweetedStatusIdStr` does not exist on the real `TweetLegacy` model — a retweet is
 * instead represented by `TweetApiUtilsData.retweeted` holding the full retweeted entry,
 * so its id is read from there. The quoted tweet follows the same shape via
 * `TweetApiUtilsData.quoted`; its own `legacy` can be absent (tombstoned/withheld quoted
 * tweet), so `quotedStatusResult.result.legacy` is left `undefined` in that case rather
 * than assuming it always exists.
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
      // Absent contentDisclosure.aiGeneratedDisclosure is left as null (unknown), not
      // coerced to false: X only sometimes attaches this sub-object, and there is no
      // confirmed guarantee that its absence always means "not AI-generated" rather than
      // "not evaluated for this tweet/fetch path".
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
 * Awaits a real `twitter-openapi-typescript` API response and converts its
 * `TweetApiUtilsData[]` payload into `RawTweetResult[]`, carrying along the bottom cursor
 * for pagination (same field `./follows.ts`'s `convertFollowListResponse` reads) and the
 * pre-filter entry count as `rawCount` (see {@link TimelinePage}). Exported because
 * `TweetDetailApiLike` (`./engagement`) wraps `TweetApiUtils.getTweetDetail`, whose response
 * has this exact same `TwitterApiUtilsResponse<TimelineApiUtilsResponse<TweetApiUtilsData>>`
 * shape.
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
 * Wraps the real `twitter-openapi-typescript` tweet API (`client.getTweetApi()`) into a
 * `TweetApiLike`, converting each response's `TweetApiUtilsData[]` into `RawTweetResult[]`.
 * Method names and the `{ data: { data: [...] } }` nesting already match `TweetApiLike`;
 * only the per-entry element shape needs conversion, handled by {@link toRawTweetResult}.
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
