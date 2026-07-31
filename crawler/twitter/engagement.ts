import type { TweetApiUtils } from 'twitter-openapi-typescript'
import { toAccountProfileInput, toTweetInput, type RawTweetResult } from './mappers'
import { convertTimelineResponse } from './timeline'
import type { AccountProfileInput } from '../db/account-repository'
import type { TweetInput } from '../db/tweet-repository'

/**
 * Sorts tweets by descending engagement (retweetCount + likeCount).
 * @param tweets - tweets to sort
 * @returns a new array sorted by descending engagement
 */
export function sortByEngagement(tweets: TweetInput[]): TweetInput[] {
  // eslint-disable-next-line unicorn/no-array-sort -- toSorted() requires ES2023 lib, but tsconfig targets ES2022; sorting a spread copy avoids mutating the input
  return [...tweets].sort(
    (a, b) => b.retweetCount + b.likeCount - (a.retweetCount + a.likeCount),
  )
}

export interface TweetDetailApiLike {
  getTweetDetail(param: { focalTweetId: string }): Promise<{ data: { data: RawTweetResult[] } }>
}

export interface RepliesResult {
  authorReplies: TweetInput[]
  otherReplies: TweetInput[]
  /** Profiles of every reply author, including non-timeline third parties, derived from the same response (no extra API calls). */
  authors: AccountProfileInput[]
}

/**
 * Fetches replies to a tweet and splits them into replies from the tweet's own author
 * (thread continuations) and replies from anyone else.
 * @param client - tweet detail API client
 * @param parentTweet - the tweet whose replies to fetch
 * @param limit - maximum number of replies to consider
 * @returns replies split into `authorReplies` and `otherReplies`, plus the replies' author profiles
 */
export async function fetchReplies(
  client: TweetDetailApiLike,
  parentTweet: TweetInput,
  limit: number,
): Promise<RepliesResult> {
  const response = await client.getTweetDetail({ focalTweetId: parentTweet.id })
  const rawReplies = response.data.data
    .filter((raw) => raw.legacy.inReplyToStatusIdStr === parentTweet.id)
    .slice(0, limit)
  const replies = rawReplies.map((raw) =>
    toTweetInput(raw, { source: parentTweet.source, viewerAccountId: parentTweet.accountId }),
  )

  return {
    authorReplies: replies.filter((r) => r.isAuthorReply),
    otherReplies: replies.filter((r) => !r.isAuthorReply),
    authors: rawReplies.map((raw) => toAccountProfileInput(raw.user)),
  }
}

/**
 * Wraps the real `twitter-openapi-typescript` tweet API (`client.getTweetApi()`) into a
 * `TweetDetailApiLike`, converting `getTweetDetail`'s `TweetApiUtilsData[]` response into
 * `RawTweetResult[]` via {@link convertTimelineResponse} — `getTweetDetail`'s response
 * shape is identical to the timeline endpoints wrapped by `./timeline`'s
 * `createTweetApiLike`, so the same converter applies.
 * @param tweetApi - the real tweet API, e.g. from `TwitterOpenApiClient.getTweetApi()`
 * @returns a `TweetDetailApiLike` usable with {@link fetchReplies}
 */
export function createTweetDetailApiLike(tweetApi: TweetApiUtils): TweetDetailApiLike {
  return {
    getTweetDetail: (param) => convertTimelineResponse(tweetApi.getTweetDetail(param)),
  }
}
